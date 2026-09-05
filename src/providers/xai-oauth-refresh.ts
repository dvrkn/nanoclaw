/**
 * xAI OAuth refresher — keeps the vaulted Grok access token alive.
 *
 * Started with the host (`onHostStart` in ./xai.ts). Every tick it re-reads
 * `data/xai-oauth.json` (never cached: a re-login from setup replaces the file
 * under a running host), and when the access token is inside its refresh
 * margin it runs the refresh grant, persists the rotated pair, and rotates the
 * vault copy through the OneCLI gateway API (./xai-vault.ts — no `onecli`
 * binary needed on the host, which matters when the host itself runs in a
 * container). OneCLI resolves secrets per request, so running containers pick
 * the new token up without a restart.
 *
 * Ordering is file-first: the rotated refresh token is written before the
 * vault push, because a consumed refresh token that never reached disk is a
 * dead grant (xAI rotates on every refresh), whereas a vault push that failed
 * is retried on the next tick — `vaultAccess` records what the vault holds, so
 * a lagging vault is detected independently of expiry.
 *
 * A structurally dead grant (`invalid_grant`) is terminal: the record is
 * marked `needsRelogin`, the refresher stops touching it, and the operator
 * re-runs `pnpm exec tsx setup/index.ts --step provider-auth xai`.
 */
import { log } from '../log.js';
import {
  applyRefreshedTokens,
  isXaiOAuthGrantDead,
  readXaiCredential,
  refreshXaiOAuthTokens,
  writeXaiCredential,
  xaiCredentialPath,
  type XaiOAuthCredential,
  type XaiOAuthFetchOptions,
} from './xai-oauth.js';
import { createXaiVaultClient } from './xai-vault.js';

/** Refresh this long before the access token expires. */
export const XAI_REFRESH_MARGIN_MS = 10 * 60_000;
/** How often the host checks. */
export const XAI_REFRESH_TICK_MS = 60_000;
/** Lifetime assumed when xAI sends neither `expires_in` nor a JWT `exp`. */
export const XAI_ASSUMED_ACCESS_LIFETIME_MS = 60 * 60_000;
/** Re-log a persistent condition (dead grant, missing secret id) at most this often. */
const REPEAT_LOG_INTERVAL_MS = 30 * 60_000;

export type XaiRefreshOutcome = 'no-credential' | 'fresh' | 'refreshed' | 'vault-synced' | 'needs-relogin' | 'failed';

export interface XaiRefreshDeps extends Pick<XaiOAuthFetchOptions, 'fetchImpl' | 'now' | 'sleep'> {
  credentialPath?: string;
  /** Rotate the vault copy. Defaults to the OneCLI gateway (`PATCH /v1/secrets/:id`), CLI when no gateway URL is configured. */
  updateSecret?: (secretId: string, value: string) => Promise<void>;
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

/** Absolute time (ms) at which the stored access token should be refreshed. */
export function xaiRefreshDueAt(cred: Pick<XaiOAuthCredential, 'expires' | 'obtainedAt'>): number {
  if (typeof cred.expires === 'number' && Number.isFinite(cred.expires)) return cred.expires - XAI_REFRESH_MARGIN_MS;
  const obtained = Date.parse(cred.obtainedAt);
  const base = Number.isFinite(obtained) ? obtained : 0;
  return base + XAI_ASSUMED_ACCESS_LIFETIME_MS - XAI_REFRESH_MARGIN_MS;
}

export function isXaiRefreshDue(cred: Pick<XaiOAuthCredential, 'expires' | 'obtainedAt'>, now: number): boolean {
  return now >= xaiRefreshDueAt(cred);
}

async function updateVaultSecret(secretId: string, value: string): Promise<void> {
  // `value` is a live credential: JSON body or argv, never a shell string, never logged.
  await createXaiVaultClient().update(secretId, value);
}

const lastLoggedAt = new Map<string, number>();
function logThrottled(
  logger: NonNullable<XaiRefreshDeps['logger']>,
  level: 'warn' | 'error',
  key: string,
  message: string,
  meta: Record<string, unknown>,
  now: number,
): void {
  const last = lastLoggedAt.get(key);
  if (last !== undefined && now - last < REPEAT_LOG_INTERVAL_MS) return;
  lastLoggedAt.set(key, now);
  logger[level](message, meta);
}

/** Test seam: forget the log throttle state. */
export function _resetXaiRefreshLogThrottleForTesting(): void {
  lastLoggedAt.clear();
}

/**
 * One refresher tick. Idempotent and safe to call concurrently with a setup
 * re-login: the file is re-read after the grant, and a record that changed
 * under us (a newer login) is left alone.
 */
export async function refreshXaiCredentialIfDue(deps: XaiRefreshDeps = {}): Promise<XaiRefreshOutcome> {
  const logger = deps.logger ?? log;
  const now = deps.now ?? Date.now;
  const credentialPath = deps.credentialPath ?? xaiCredentialPath();
  const updateSecret = deps.updateSecret ?? updateVaultSecret;

  let cred: XaiOAuthCredential | null;
  try {
    cred = readXaiCredential(credentialPath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- logged and surfaced as a failed tick; a bad file must never take the host down
  } catch (err) {
    logThrottled(
      logger,
      'error',
      'unreadable',
      'xAI OAuth credential file is unreadable',
      { credentialPath, err },
      now(),
    );
    return 'failed';
  }
  if (!cred) return 'no-credential';

  if (cred.needsRelogin) {
    logThrottled(
      logger,
      'error',
      'relogin',
      'xAI OAuth session is dead — re-run `pnpm exec tsx setup/index.ts --step provider-auth xai`',
      { reason: cred.needsRelogin, email: cred.email },
      now(),
    );
    return 'needs-relogin';
  }

  const pushToVault = async (record: XaiOAuthCredential): Promise<boolean> => {
    if (!record.secretId) {
      logThrottled(
        logger,
        'warn',
        'no-secret-id',
        'xAI OAuth credential has no vault secret id — the vault copy cannot be rotated; re-run the xAI login',
        { credentialPath },
        now(),
      );
      return false;
    }
    try {
      await updateSecret(record.secretId, record.access);
      // eslint-disable-next-line no-catch-all/no-catch-all -- the vault push is retried on the next tick (vaultAccess lags access)
    } catch (err) {
      logger.warn('xAI OAuth vault rotation failed — will retry next tick', { secretId: record.secretId, err });
      return false;
    }
    writeXaiCredential({ ...record, vaultAccess: record.access }, credentialPath);
    logger.info('xAI OAuth access token rotated in the vault', {
      secretId: record.secretId,
      expires: record.expires ? new Date(record.expires).toISOString() : undefined,
    });
    return true;
  };

  if (!isXaiRefreshDue(cred, now())) {
    // Not due — but a vault push that failed on an earlier tick is retried here.
    if (cred.vaultAccess !== undefined && cred.vaultAccess !== cred.access) {
      return (await pushToVault(cred)) ? 'vault-synced' : 'failed';
    }
    return 'fresh';
  }

  let refreshed: XaiOAuthCredential;
  try {
    const tokens = await refreshXaiOAuthTokens({
      tokenEndpoint: cred.tokenEndpoint,
      refreshToken: cred.refresh,
      fetchImpl: deps.fetchImpl,
      now,
      sleep: deps.sleep,
    });
    refreshed = applyRefreshedTokens(cred, tokens, now);
    // eslint-disable-next-line no-catch-all/no-catch-all -- classified below: a dead grant is recorded, anything else is retried next tick
  } catch (err) {
    if (isXaiOAuthGrantDead(err)) {
      const reason = err instanceof Error ? err.message : String(err);
      // Re-read before marking: a newer login may already have replaced the grant.
      const current = safeRead(credentialPath);
      if (current && current.refresh !== cred.refresh) return 'fresh';
      writeXaiCredential({ ...cred, needsRelogin: reason }, credentialPath);
      logger.error('xAI OAuth refresh was rejected — re-run `pnpm exec tsx setup/index.ts --step provider-auth xai`', {
        reason,
        email: cred.email,
      });
      return 'needs-relogin';
    }
    logger.warn('xAI OAuth refresh failed — will retry next tick', { err });
    return 'failed';
  }

  // A re-login that landed while the grant was in flight wins: its tokens are
  // already in the vault, and ours belong to the grant chain it superseded.
  const current = safeRead(credentialPath);
  if (current && current.refresh !== cred.refresh) {
    logger.info('xAI OAuth credential changed during refresh — keeping the newer login');
    return 'fresh';
  }

  // File first (the rotated refresh token must never be lost), then the vault.
  writeXaiCredential({ ...refreshed, vaultAccess: cred.vaultAccess ?? cred.access }, credentialPath);
  const synced = await pushToVault({ ...refreshed, vaultAccess: cred.vaultAccess ?? cred.access });
  return synced ? 'refreshed' : 'failed';
}

function safeRead(credentialPath: string): XaiOAuthCredential | null {
  try {
    return readXaiCredential(credentialPath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the primary read at the top of the tick reports a corrupt record
  } catch {
    return null;
  }
}

/**
 * Start the periodic refresher. Never throws — a broken credential must not
 * abort host startup (`onHostStart` errors do); it logs and retries.
 */
export function startXaiOAuthRefresher(signal: AbortSignal, deps: XaiRefreshDeps = {}): void {
  const logger = deps.logger ?? log;
  const tick = (): void => {
    refreshXaiCredentialIfDue(deps).catch((err: unknown) => {
      logger.warn('xAI OAuth refresher tick threw', { err });
    });
  };
  tick();
  const timer = setInterval(tick, XAI_REFRESH_TICK_MS);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
