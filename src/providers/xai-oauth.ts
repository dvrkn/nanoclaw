/**
 * xAI (Grok) OAuth — device-code login, token refresh, and the host-side
 * credential record. A plain-fetch port of openclaw's `extensions/xai/xai-oauth.ts`
 * (the `xai-device-code` auth method) onto NanoClaw's host runtime.
 *
 * Two consumers, one module:
 *   - `setup/providers/xai.ts` runs the device-code login (discovery → device
 *     authorization → token poll) and vaults the access token.
 *   - `src/providers/xai-oauth-refresh.ts` (started with the host) refreshes
 *     the access token before it expires and rotates the vault copy.
 *
 * What the OAuth grant buys: a SuperGrok subscription session against xAI's
 * Grok CLI proxy (`cli-chat-proxy.grok.com`) — the same backend Grok Build /
 * openclaw's xAI OAuth use — rather than the pay-per-use `api.x.ai`. The proxy
 * speaks the OpenAI Responses API and wants the Grok CLI identity headers
 * (see `container/agent-runner/src/providers/xai.ts`).
 *
 * Credential invariant. Containers never see a token: the access token lives
 * in the OneCLI vault as a Bearer header rewrite for the proxy host, and the
 * container carries a `placeholder` bearer. The refresh token has to live on
 * the host (OneCLI has no xAI refresh type, and refresh is a form-body grant no
 * header-injecting proxy can perform), so it sits in `data/xai-oauth.json`,
 * mode 0600, never mounted, wiped by uninstall. Nothing lands in `.env`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

export const XAI_PROVIDER_ID = 'xai';
/** xAI's shared OAuth client (the one Grok Build and openclaw sign in with). */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;

/** Subscription backend the OAuth grant is valid for (OpenAI Responses API). */
export const XAI_GROK_OAUTH_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_GROK_OAUTH_HOST = 'cli-chat-proxy.grok.com';
/** Pay-per-use API an xAI API key is valid for. */
export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
export const XAI_API_HOST = 'api.x.ai';
/** Model used when neither the group config nor the install names one. */
export const XAI_DEFAULT_MODEL_ID = 'grok-4.3';
/** Grok CLI identity the proxy expects (`x-grok-client-version`). */
export const XAI_GROK_CLIENT_VERSION = '1.0.4';

/** Name of the OneCLI secret both auth modes create. */
export const XAI_SECRET_NAME = 'xAI';

const XAI_USER_AGENT = 'nanoclaw';
const FETCH_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const DEVICE_CODE_TIMEOUT_MS = 5 * 60_000;
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_RETRY_DELAY_MS = 250;

export interface XaiOAuthFetchOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface XaiDeviceCodeDiscovery {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface XaiDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInMs: number;
  intervalMs: number;
}

export interface XaiOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, ms since epoch. */
  expires?: number;
  idToken?: string;
}

export interface XaiOAuthIdentity {
  email?: string;
  displayName?: string;
  accountId?: string;
}

/**
 * The host-side credential record (`data/xai-oauth.json`). `access` is a copy
 * of what the vault holds so the refresher can tell whether the vault is
 * current; `refresh` is the only place the refresh token exists.
 */
export interface XaiOAuthCredential {
  version: 1;
  provider: typeof XAI_PROVIDER_ID;
  authFlow: 'device-code';
  access: string;
  refresh: string;
  /** Absolute access-token expiry (ms since epoch); absent when xAI sent none. */
  expires?: number;
  /** ISO timestamp of the grant that produced `access`. */
  obtainedAt: string;
  idToken?: string;
  email?: string;
  displayName?: string;
  accountId?: string;
  issuer: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  /** OneCLI secret id the refresher rotates (`onecli secrets update --id`). */
  secretId?: string;
  secretName: string;
  hostPattern: string;
  /** The access token last confirmed in the vault; differs from `access` while a rotation is pending. */
  vaultAccess?: string;
  /** Set by the refresher when the grant is dead (invalid_grant) — re-run login. */
  needsRelogin?: string;
}

export class XaiOAuthError extends Error {
  /** Structured OAuth error code (`invalid_grant`, `access_denied`, …) when xAI sent one. */
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { code?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'XaiOAuthError';
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
  }
}

/** True when the grant itself is dead and only a fresh login can recover. */
export function isXaiOAuthGrantDead(err: unknown): boolean {
  return err instanceof XaiOAuthError && (err.code === 'invalid_grant' || err.code === 'invalid_client');
}

// ─── transport ───────────────────────────────────────────────────────────

function isTrustedXaiOAuthEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && (url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed URL is exactly the untrusted case
  } catch {
    return false;
  }
}

function requireTrustedXaiOAuthEndpoint(endpoint: string, label: string): string {
  if (!isTrustedXaiOAuthEndpoint(endpoint)) {
    throw new XaiOAuthError(`xAI OAuth discovery returned untrusted ${label}`);
  }
  return endpoint;
}

function toFormUrlEncoded(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface XaiOAuthResponseBody {
  json: Record<string, unknown> | null;
  text: string;
}

async function readResponseBody(response: Response): Promise<XaiOAuthResponseBody> {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > RESPONSE_MAX_BYTES) {
    throw new XaiOAuthError(`xAI OAuth response exceeds ${RESPONSE_MAX_BYTES} bytes`);
  }
  const text = buffer.toString('utf8');
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON body is reported through the HTTP status by every caller
  } catch {
    json = null;
  }
  return { json, text };
}

async function fetchXaiOAuth(
  url: string,
  options: XaiOAuthFetchOptions,
  body?: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; body: XaiOAuthResponseBody }> {
  if (!/^https:/i.test(url)) throw new XaiOAuthError(`xAI OAuth endpoint must be https: ${url}`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': XAI_USER_AGENT,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: toFormUrlEncoded(body) } : {}),
    // A redirect off the discovered endpoint is not something to follow blindly.
    redirect: 'error',
    signal: combineSignals(FETCH_TIMEOUT_MS, options.signal),
  });
  return { response, body: await readResponseBody(response) };
}

function oauthErrorOf(body: XaiOAuthResponseBody): { error?: string; description?: string } {
  const error = typeof body.json?.error === 'string' ? body.json.error : undefined;
  const description = typeof body.json?.error_description === 'string' ? body.json.error_description : undefined;
  return { error, description };
}

function formatXaiOAuthError(context: string, status: number, body: XaiOAuthResponseBody): string {
  const { error, description } = oauthErrorOf(body);
  if (error && description) return `${context} failed (${status}): ${error} (${description})`;
  if (error) return `${context} failed (${status}): ${error}`;
  return `${context} failed (${status})`;
}

function isLikelyCloudflareChallenge(response: Response, bodyText: string): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    response.headers.get('cf-mitigated') === 'challenge' ||
    /text\/html/i.test(contentType) ||
    /<!doctype html|<html\b/i.test(bodyText) ||
    /\b(?:cloudflare|attention required|just a moment|enable javascript and cookies|challenge-platform)\b/i.test(
      bodyText,
    )
  );
}

// ─── discovery ───────────────────────────────────────────────────────────

export async function fetchXaiDeviceCodeDiscovery(options: XaiOAuthFetchOptions = {}): Promise<XaiDeviceCodeDiscovery> {
  const { response, body } = await fetchXaiOAuth(XAI_OAUTH_DISCOVERY_URL, options);
  if (!response.ok) throw new XaiOAuthError(formatXaiOAuthError('xAI OAuth discovery', response.status, body));
  const deviceAuthorizationEndpoint = body.json?.device_authorization_endpoint;
  const tokenEndpoint = body.json?.token_endpoint;
  if (typeof deviceAuthorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new XaiOAuthError('xAI OAuth discovery response is missing device code endpoints');
  }
  return {
    deviceAuthorizationEndpoint: requireTrustedXaiOAuthEndpoint(
      deviceAuthorizationEndpoint,
      'device authorization endpoint',
    ),
    tokenEndpoint: requireTrustedXaiOAuthEndpoint(tokenEndpoint, 'token endpoint'),
  };
}

// ─── tokens ──────────────────────────────────────────────────────────────

function positiveSecondsToMs(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER);
}

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  const part = token?.split('.')[1];
  if (!part) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- an undecodable JWT simply yields no identity or expiry hint
  } catch {
    return {};
  }
}

function deriveExpiresFromJwt(token: string): number | undefined {
  const exp = decodeJwtPayload(token).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined;
  return exp * 1000;
}

export function parseXaiOAuthTokenResponse(
  json: Record<string, unknown> | null,
  now: () => number,
  options: { requireRefreshToken?: boolean } = {},
): XaiOAuthTokens {
  const accessToken = json?.access_token;
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new XaiOAuthError('xAI OAuth token response is missing access_token');
  }
  const refreshToken =
    typeof json?.refresh_token === 'string' && json.refresh_token.trim().length > 0 ? json.refresh_token : undefined;
  if (options.requireRefreshToken && !refreshToken) {
    throw new XaiOAuthError(
      'xAI OAuth token response is missing refresh_token. Re-run the login; if it persists, the OAuth client is not issuing refresh tokens (offline_access rejected).',
    );
  }
  const idToken = typeof json?.id_token === 'string' && json.id_token.trim().length > 0 ? json.id_token : undefined;
  // RFC 6749 expires_in first; the access-token JWT exp is the only legitimate
  // fallback — an id_token exp describes the OIDC session, not the access token.
  const expiresInMs = positiveSecondsToMs(json?.expires_in);
  const expires = expiresInMs !== undefined ? now() + expiresInMs : deriveExpiresFromJwt(accessToken);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expires ? { expires } : {}),
  };
}

export function resolveXaiOAuthIdentity(tokens: Pick<XaiOAuthTokens, 'accessToken' | 'idToken'>): XaiOAuthIdentity {
  const payload = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  return {
    ...(email ? { email } : {}),
    ...(name ? { displayName: name } : {}),
    ...(sub ? { accountId: sub } : {}),
  };
}

// ─── device code ─────────────────────────────────────────────────────────

export async function requestXaiDeviceCode(
  params: { deviceAuthorizationEndpoint: string } & XaiOAuthFetchOptions,
): Promise<XaiDeviceCode> {
  const endpoint = requireTrustedXaiOAuthEndpoint(params.deviceAuthorizationEndpoint, 'device authorization endpoint');
  const { response, body } = await fetchXaiOAuth(endpoint, params, {
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  if (!response.ok) throw new XaiOAuthError(formatXaiOAuthError('xAI device code request', response.status, body));
  const json = body.json ?? {};
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const verificationUriComplete = json.verification_uri_complete;
  if (
    typeof deviceCode !== 'string' ||
    !deviceCode.trim() ||
    typeof userCode !== 'string' ||
    !userCode.trim() ||
    typeof verificationUri !== 'string' ||
    !verificationUri.trim()
  ) {
    throw new XaiOAuthError('xAI device code response is missing device_code, user_code, or verification_uri');
  }
  return {
    deviceCode,
    userCode,
    verificationUri: requireTrustedXaiOAuthEndpoint(verificationUri, 'device verification URI'),
    ...(typeof verificationUriComplete === 'string' && verificationUriComplete.trim()
      ? {
          verificationUriComplete: requireTrustedXaiOAuthEndpoint(
            verificationUriComplete,
            'complete device verification URI',
          ),
        }
      : {}),
    expiresInMs: positiveSecondsToMs(json.expires_in) ?? DEVICE_CODE_TIMEOUT_MS,
    intervalMs: positiveSecondsToMs(json.interval) ?? DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new XaiOAuthError('xAI login cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function pollXaiDeviceCodeToken(
  params: { tokenEndpoint: string; deviceCode: string; expiresInMs: number; intervalMs: number } & XaiOAuthFetchOptions,
): Promise<XaiOAuthTokens> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const endpoint = requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, 'token endpoint');
  const deadline = now() + params.expiresInMs;
  let intervalMs = params.intervalMs;

  while (now() < deadline) {
    const { response, body } = await fetchXaiOAuth(endpoint, params, {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: params.deviceCode,
    });
    if (response.ok) return parseXaiOAuthTokenResponse(body.json, now, { requireRefreshToken: true });

    const { error } = oauthErrorOf(body);
    if (error === 'authorization_pending' || error === 'slow_down') {
      if (error === 'slow_down') intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      const remaining = Math.max(0, deadline - now());
      await sleep(Math.min(Math.max(intervalMs, DEVICE_CODE_MIN_INTERVAL_MS), remaining), params.signal);
      continue;
    }
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new XaiOAuthError('xAI device authorization was denied', { code: error });
    }
    if (error === 'expired_token') {
      throw new XaiOAuthError('xAI device code expired. Re-run the login.', { code: error });
    }
    throw new XaiOAuthError(formatXaiOAuthError('xAI device token exchange', response.status, body), { code: error });
  }
  throw new XaiOAuthError('xAI device authorization timed out');
}

// ─── refresh ─────────────────────────────────────────────────────────────

export async function refreshXaiOAuthTokens(
  params: { tokenEndpoint: string; refreshToken: string } & XaiOAuthFetchOptions,
): Promise<XaiOAuthTokens> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const endpoint = requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, 'token endpoint');
  let lastMessage = 'xAI OAuth refresh failed';

  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
    let result: Awaited<ReturnType<typeof fetchXaiOAuth>>;
    try {
      result = await fetchXaiOAuth(endpoint, params, {
        grant_type: 'refresh_token',
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: params.refreshToken,
      });
    } catch (err) {
      // Transport failures are NOT retried: xAI rotates refresh tokens, so a
      // response lost after xAI consumed the token would burn it on resend.
      throw new XaiOAuthError(`xAI OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
        cause: err,
      });
    }
    const { response, body } = result;
    if (response.ok) return parseXaiOAuthTokenResponse(body.json, now);

    const { error } = oauthErrorOf(body);
    const challenge = !error && isLikelyCloudflareChallenge(response, body.text);
    lastMessage = challenge
      ? `xAI OAuth refresh failed (${response.status}): xAI returned an HTML/Cloudflare challenge instead of OAuth JSON — try again later or re-run xAI OAuth login.`
      : formatXaiOAuthError('xAI OAuth refresh', response.status, body);
    // A structured OAuth error (invalid_grant, …) is authoritative and final;
    // only the intermediary challenge page is worth retrying.
    if (!challenge) throw new XaiOAuthError(lastMessage, { code: error, retryable: response.status >= 500 });
    if (attempt < REFRESH_MAX_ATTEMPTS) await sleep(REFRESH_RETRY_DELAY_MS, params.signal);
  }
  throw new XaiOAuthError(lastMessage, { retryable: true });
}

// ─── Grok OAuth catalog (best-effort model discovery) ────────────────────

export interface XaiGrokCatalog {
  models: string[];
  defaultModel?: string;
}

/** Identity headers the Grok CLI proxy expects alongside the bearer token. */
export function xaiGrokProxyHeaders(
  model?: string,
  clientVersion: string = XAI_GROK_CLIENT_VERSION,
): Record<string, string> {
  return {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': clientVersion,
    ...(model ? { 'x-grok-model-override': model } : {}),
  };
}

/**
 * Ask the proxy which models the signed-in account can use and which one it
 * treats as the default. Advisory only — callers fall back to the built-in
 * default when this throws.
 */
export async function fetchXaiGrokOAuthCatalog(
  params: { accessToken: string; baseUrl?: string } & XaiOAuthFetchOptions,
): Promise<XaiGrokCatalog> {
  const base = (params.baseUrl ?? XAI_GROK_OAUTH_BASE_URL).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${params.accessToken}`, ...xaiGrokProxyHeaders() };
  const models = await fetchXaiOAuth(`${base}/models`, params, undefined, headers);
  if (!models.response.ok) {
    throw new XaiOAuthError(formatXaiOAuthError('xAI model discovery', models.response.status, models.body));
  }
  const rows = Array.isArray(models.body.json?.data) ? (models.body.json?.data as unknown[]) : [];
  const ids = rows
    .map((row) => {
      if (!row || typeof row !== 'object') return undefined;
      const r = row as Record<string, unknown>;
      const backend = typeof r.api_backend === 'string' ? r.api_backend.toLowerCase() : undefined;
      // Image models and other non-language backends can't run an agent turn.
      if (backend && !['responses', 'chat', 'language'].includes(backend)) return undefined;
      const id = typeof r.id === 'string' ? r.id : typeof r.model === 'string' ? r.model : undefined;
      return id && !/imagine|image/i.test(id) ? id : undefined;
    })
    .filter((id): id is string => Boolean(id));

  let defaultModel: string | undefined;
  try {
    const settings = await fetchXaiOAuth(`${base}/settings`, params, undefined, headers);
    const value = settings.body.json?.default_model;
    if (settings.response.ok && typeof value === 'string' && value.trim()) defaultModel = value.trim();
    // eslint-disable-next-line no-catch-all/no-catch-all -- the default-model hint is advisory; the model list already succeeded
  } catch {
    defaultModel = undefined;
  }
  return { models: ids, ...(defaultModel ? { defaultModel } : {}) };
}

// ─── credential store ────────────────────────────────────────────────────

export function xaiCredentialPath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'xai-oauth.json');
}

export function readXaiCredential(filePath: string = xaiCredentialPath()): XaiOAuthCredential | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error(`${filePath} must contain a JSON object`);
  const cred = parsed as XaiOAuthCredential;
  if (cred.version !== 1 || cred.provider !== XAI_PROVIDER_ID || typeof cred.refresh !== 'string') {
    throw new Error(`${filePath} is not a NanoClaw xAI OAuth credential (re-run the xAI login)`);
  }
  return cred;
}

/** Atomic write, owner-only permissions — the file holds a live refresh token. */
export function writeXaiCredential(cred: XaiOAuthCredential, filePath: string = xaiCredentialPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export function deleteXaiCredential(filePath: string = xaiCredentialPath()): void {
  fs.rmSync(filePath, { force: true });
}

export function buildXaiCredential(params: {
  tokens: XaiOAuthTokens;
  discovery: XaiDeviceCodeDiscovery;
  identity?: XaiOAuthIdentity;
  secretId?: string;
  secretName?: string;
  hostPattern?: string;
  /** True once the access token has been written to the vault. */
  vaulted?: boolean;
  now?: () => number;
}): XaiOAuthCredential {
  const { tokens, discovery } = params;
  if (!tokens.refreshToken) throw new XaiOAuthError('xAI OAuth credential is missing refresh token');
  const identity = params.identity ?? resolveXaiOAuthIdentity(tokens);
  return {
    version: 1,
    provider: XAI_PROVIDER_ID,
    authFlow: 'device-code',
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    ...(tokens.expires ? { expires: tokens.expires } : {}),
    obtainedAt: new Date((params.now ?? Date.now)()).toISOString(),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    issuer: XAI_OAUTH_ISSUER,
    tokenEndpoint: discovery.tokenEndpoint,
    deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
    ...(params.secretId ? { secretId: params.secretId } : {}),
    secretName: params.secretName ?? XAI_SECRET_NAME,
    hostPattern: params.hostPattern ?? XAI_GROK_OAUTH_HOST,
    ...(params.vaulted ? { vaultAccess: tokens.accessToken } : {}),
  };
}

/** Apply a refresh result to a stored credential (refresh tokens rotate). */
export function applyRefreshedTokens(
  cred: XaiOAuthCredential,
  tokens: XaiOAuthTokens,
  now: () => number = Date.now,
): XaiOAuthCredential {
  const identity = resolveXaiOAuthIdentity(tokens);
  const next: XaiOAuthCredential = {
    ...cred,
    access: tokens.accessToken,
    refresh: tokens.refreshToken ?? cred.refresh,
    obtainedAt: new Date(now()).toISOString(),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
  };
  if (tokens.expires) next.expires = tokens.expires;
  else delete next.expires;
  delete next.needsRelogin;
  return next;
}
