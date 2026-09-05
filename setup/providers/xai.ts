/**
 * xAI (Grok) provider setup — auth walk-through + install verification.
 *
 * xai-owned payload code: it travels with the provider on the `providers`
 * branch and `/add-xai` copies it back in. The only trunk reach-ins are one
 * barrel import and the picker/install entries in setup/auto.ts and
 * setup/provider-auth.ts.
 *
 * Auth honors the v2 credential invariant — the token the container's traffic
 * uses lands in the OneCLI vault, nothing in .env, nothing in the container:
 *   - SuperGrok subscription (the common case): xAI's OAuth device-code flow
 *     (the same `xai-device-code` login openclaw ships) runs in-process — a
 *     URL and a one-time code, no localhost callback, so it works over SSH.
 *     The access token is vaulted as a Bearer rewrite for the Grok CLI proxy
 *     host; the refresh token stays host-only in `data/xai-oauth.json` (0600)
 *     for the host refresher (src/providers/xai-oauth-refresh.ts), which
 *     rotates the vault copy before every expiry.
 *   - API key: pasted once, vaulted as a Bearer rewrite for api.x.ai.
 *
 * Which backend the credential is valid for is recorded (non-secret) as
 * XAI_BASE_URL in .env, with the chosen default model as XAI_DEFAULT_MODEL.
 */
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from '../lib/bright-select.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { isHeadless, openBrowser } from '../platform.js';
import { upsertEnvVar } from '../set-env.js';
import { registerSetupProvider } from './registry.js';
import {
  XAI_API_BASE_URL,
  XAI_API_HOST,
  XAI_DEFAULT_MODEL_ID,
  XAI_GROK_OAUTH_BASE_URL,
  XAI_GROK_OAUTH_HOST,
  XAI_SECRET_NAME,
  buildXaiCredential,
  fetchXaiDeviceCodeDiscovery,
  fetchXaiGrokOAuthCatalog,
  pollXaiDeviceCodeToken,
  readXaiCredential,
  requestXaiDeviceCode,
  resolveXaiOAuthIdentity,
  writeXaiCredential,
  xaiCredentialPath,
  type XaiDeviceCode,
  type XaiDeviceCodeDiscovery,
  type XaiGrokCatalog,
  type XaiOAuthFetchOptions,
  type XaiOAuthIdentity,
  type XaiOAuthTokens,
} from '../../src/providers/xai-oauth.js';
import { createXaiVaultClient, type XaiVaultSecret } from '../../src/providers/xai-vault.js';

// ─── OneCLI vault helpers ────────────────────────────────────────────────
//
// Gateway REST when ONECLI_URL is configured (the same URL the host uses), the
// `onecli` CLI otherwise — see src/providers/xai-vault.ts. Either way the
// secret value rides a JSON body or argv, never a shell string.

type OnecliSecret = XaiVaultSecret;

const vault = () => createXaiVaultClient();

/**
 * The vault entry THIS walk-through owns — matched by our name only. A secret
 * the operator created themselves for an xAI host (an `XAI_API_KEY` migrated
 * from .env, say) is never reused or overwritten: it may hold a different
 * credential for a different backend, and its value cannot be recovered.
 */
export function findXaiSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => s.name.toLowerCase() === XAI_SECRET_NAME.toLowerCase());
}

/** Operator-owned secrets that already rewrite an xAI backend host — reported, never touched. */
export function findForeignXaiSecrets(secrets: OnecliSecret[]): OnecliSecret[] {
  const ours = findXaiSecret(secrets);
  return secrets.filter((s) => {
    if (s === ours) return false;
    const hostPattern = (s.hostPattern ?? '').toLowerCase();
    return hostPattern.includes(XAI_GROK_OAUTH_HOST) || hostPattern.includes(XAI_API_HOST);
  });
}

async function listVaultSecrets(): Promise<OnecliSecret[]> {
  try {
    return await vault().list();
  } catch {
    return [];
  }
}

/**
 * Land a credential for a backend host in OUR secret: update it in place when it
 * exists (moving its host pattern when the auth mode changed), create it
 * otherwise. Returns the secret id when the backend reports one.
 */
async function vaultXaiCredential(
  existing: OnecliSecret | undefined,
  value: string,
  hostPattern: string,
): Promise<string | undefined> {
  if (existing) {
    await vault().update(existing.id, value, existing.hostPattern === hostPattern ? undefined : { hostPattern });
    return existing.id;
  }
  const id = await vault().create({
    name: XAI_SECRET_NAME,
    value,
    hostPattern,
    headerName: 'Authorization',
    valueFormat: 'Bearer {value}',
  });
  return id ?? findXaiSecret(await listVaultSecrets())?.id;
}

function warnAboutForeignSecrets(secrets: OnecliSecret[], hostPattern: string): void {
  const clashing = findForeignXaiSecrets(secrets).filter((s) =>
    (s.hostPattern ?? '').toLowerCase().includes(hostPattern),
  );
  if (clashing.length === 0) return;
  p.log.warn(
    brandBody(
      `The vault already rewrites ${hostPattern} through ${clashing.map((s) => `"${s.name}"`).join(', ')}. ` +
        'That entry is left untouched, but two secrets on one host is ambiguous — remove the one you no longer need (`onecli secrets delete --id <id>`).',
    ),
  );
}

// ─── device-code login (UI-agnostic core) ────────────────────────────────

export interface XaiLoginUi {
  /** Advance the progress label. */
  progress(message: string): void;
  /** Show the verification URL + one-time code. */
  showDeviceCode(info: { url: string; code: string; expiresInMinutes: number; openedBrowser: boolean }): void;
  /** Attempt to open the URL in a browser; false when not possible/headless. */
  openUrl(url: string): boolean;
}

export interface XaiLoginDeps extends XaiOAuthFetchOptions {
  ui: XaiLoginUi;
}

export interface XaiLoginResult {
  tokens: XaiOAuthTokens;
  discovery: XaiDeviceCodeDiscovery;
  identity: XaiOAuthIdentity;
  deviceCode: XaiDeviceCode;
}

/**
 * The whole device-code dance, with the terminal abstracted away so it can
 * run under a fake fetch: discovery → device authorization → poll until the
 * user approves. Mirrors openclaw's loginXaiDeviceCode step for step.
 */
export async function runXaiDeviceCodeLogin(deps: XaiLoginDeps): Promise<XaiLoginResult> {
  const requestOptions: XaiOAuthFetchOptions = {
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    signal: deps.signal,
    sleep: deps.sleep,
  };
  deps.ui.progress('Starting xAI OAuth…');
  const discovery = await fetchXaiDeviceCodeDiscovery(requestOptions);
  deps.ui.progress('Requesting xAI OAuth device code…');
  const deviceCode = await requestXaiDeviceCode({
    deviceAuthorizationEndpoint: discovery.deviceAuthorizationEndpoint,
    ...requestOptions,
  });
  const browserUrl = deviceCode.verificationUriComplete ?? deviceCode.verificationUri;
  const openedBrowser = deps.ui.openUrl(browserUrl);
  deps.ui.showDeviceCode({
    url: deviceCode.verificationUri,
    code: deviceCode.userCode,
    expiresInMinutes: Math.max(1, Math.round(deviceCode.expiresInMs / 60_000)),
    openedBrowser,
  });
  deps.ui.progress('Waiting for xAI device authorization…');
  const tokens = await pollXaiDeviceCodeToken({
    tokenEndpoint: discovery.tokenEndpoint,
    deviceCode: deviceCode.deviceCode,
    expiresInMs: deviceCode.expiresInMs,
    intervalMs: deviceCode.intervalMs,
    ...requestOptions,
  });
  return { tokens, discovery, identity: resolveXaiOAuthIdentity(tokens), deviceCode };
}

// ─── auth step ───────────────────────────────────────────────────────────

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

function readCredentialOrNull(): ReturnType<typeof readXaiCredential> {
  try {
    return readXaiCredential();
  } catch {
    return null;
  }
}

export async function runXaiAuthStep(): Promise<void> {
  const secrets = await listVaultSecrets();
  const secret = findXaiSecret(secrets);
  const credential = readCredentialOrNull();
  if (secret && !credential?.needsRelogin) {
    p.log.success(brandBody('Your xAI account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'xai-secret-already-present', PROVIDER: 'xai' });
    return;
  }
  if (credential?.needsRelogin) {
    p.log.warn(brandBody('Your Grok sign-in expired and could not be refreshed — sign in again to reconnect.'));
  }

  const method = ensureAnswer(
    await brightSelect<'oauth' | 'api' | 'skip'>({
      message: 'How would you like to connect Grok?',
      options: [
        {
          value: 'oauth',
          label: 'Sign in with my xAI account',
          hint: 'recommended with SuperGrok — a URL and a one-time code, works over SSH',
        },
        {
          value: 'api',
          label: 'Paste an xAI API key',
          hint: 'pay-per-use via console.x.ai; stored in OneCLI, never copied into the container',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'xai groups will start, but model calls will fail auth',
        },
      ],
    }),
  );
  setupLog.userInput('xai_auth_method', method);

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: "Skip Grok sign-in? xai groups won't be able to answer until you connect an xAI account.",
        initialValue: false,
      }),
    );
    if (!confirmed) return runXaiAuthStep();
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped', PROVIDER: 'xai' });
    p.log.warn(
      brandBody('Grok sign-in skipped. Re-run `pnpm exec tsx setup/index.ts --step provider-auth xai` to connect.'),
    );
    return;
  }

  if (method === 'api') {
    await runXaiApiKeyAuth(secret, secrets);
    return;
  }
  await runXaiOAuthAuth(secret, secrets);
}

async function runXaiApiKeyAuth(existing: OnecliSecret | undefined, secrets: OnecliSecret[]): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Paste your xAI API key (xai-…)',
      validate: (v) =>
        v && v.trim().startsWith('xai-') ? undefined : 'That does not look like an xAI API key (xai-…).',
    }),
  ) as string;
  const model = await askModel({ models: [] }, XAI_DEFAULT_MODEL_ID);

  try {
    await vaultXaiCredential(existing, key.trim(), XAI_API_HOST);
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'xai', METHOD: 'api', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your xAI key to the vault. Make sure the OneCLI gateway is reachable (ONECLI_URL in .env, or `onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  // An API key never expires on its own — a stale OAuth record must not keep
  // the refresher rotating this secret.
  fs.rmSync(xaiCredentialPath(), { force: true });
  warnAboutForeignSecrets(secrets, XAI_API_HOST);
  upsertEnvVar('XAI_BASE_URL', XAI_API_BASE_URL);
  upsertEnvVar('XAI_DEFAULT_MODEL', model);
  setupLog.step('auth', 'success', 0, { PROVIDER: 'xai', METHOD: 'api', MODEL: model });
  p.log.success(brandBody('xAI account connected — the key lives in your OneCLI vault, never in the container.'));
}

export async function runXaiOAuthAuth(existing: OnecliSecret | undefined, secrets: OnecliSecret[] = []): Promise<void> {
  const headless = isHeadless();
  p.log.step(brandBody('Starting the Grok sign-in…'));
  console.log(
    k.dim(
      headless
        ? '   (a sign-in link and a one-time code will appear — open the link in any browser)'
        : '   (a browser will open; enter the one-time code shown below)',
    ),
  );
  console.log();

  const spinner = p.spinner();
  spinner.start('Starting xAI OAuth…');
  const start = Date.now();
  let login: XaiLoginResult;
  try {
    login = await runXaiDeviceCodeLogin({
      ui: {
        progress: (message) => spinner.message(message),
        openUrl: (url) => (headless ? false : openBrowser(url)),
        showDeviceCode: (info) => {
          spinner.stop('Device code issued.');
          note(
            [
              headless || !info.openedBrowser
                ? 'Open this URL in your browser and enter the code below.'
                : 'Your browser should be open — enter the code below.',
              `URL:  ${info.url}`,
              `Code: ${info.code}`,
              `Code expires in ${info.expiresInMinutes} minutes. Never share it.`,
              '',
              k.dim('xAI may label the consent app "Grok Build" — NanoClaw uses xAI\'s shared OAuth client.'),
            ].join('\n'),
            'xAI OAuth',
          );
          spinner.start('Waiting for xAI device authorization…');
        },
      },
    });
  } catch (err) {
    spinner.stop('xAI OAuth failed.', 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('auth', 'failed', Date.now() - start, { PROVIDER: 'xai', METHOD: 'oauth', ERROR: message });
    p.log.error(brandBody(`Couldn't complete the Grok sign-in: ${message}`));
    p.log.message(k.dim('Re-run setup and try again, or choose the API key option instead.'));
    process.exit(1);
  }
  spinner.stop(login.identity.email ? `Signed in as ${login.identity.email}.` : 'xAI OAuth complete.');

  // Advisory: which models this subscription can use, and its default.
  const catalog = await discoverCatalog(login.tokens.accessToken);
  const model = await askModel(catalog, catalog.defaultModel ?? XAI_DEFAULT_MODEL_ID);

  let secretId: string | undefined;
  try {
    secretId = await vaultXaiCredential(existing, login.tokens.accessToken, XAI_GROK_OAUTH_HOST);
  } catch (err) {
    setupLog.step('auth', 'failed', Date.now() - start, { PROVIDER: 'xai', METHOD: 'oauth', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your Grok token to the vault. Make sure the OneCLI gateway is reachable (ONECLI_URL in .env, or `onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }

  const credential = buildXaiCredential({
    tokens: login.tokens,
    discovery: login.discovery,
    identity: login.identity,
    secretId,
    hostPattern: XAI_GROK_OAUTH_HOST,
    vaulted: true,
  });
  writeXaiCredential(credential);
  if (!secretId) {
    p.log.warn(
      brandBody(
        'The vault did not report the new secret id, so the host cannot rotate the token automatically. Run `onecli secrets list` and put its id under "secretId" in ' +
          path.relative(process.cwd(), xaiCredentialPath()) +
          '.',
      ),
    );
  }
  warnAboutForeignSecrets(secrets, XAI_GROK_OAUTH_HOST);
  upsertEnvVar('XAI_BASE_URL', XAI_GROK_OAUTH_BASE_URL);
  upsertEnvVar('XAI_DEFAULT_MODEL', model);
  setupLog.step('auth', 'success', Date.now() - start, {
    PROVIDER: 'xai',
    METHOD: 'oauth',
    MODEL: model,
    EMAIL: login.identity.email,
    SECRET_ID: secretId,
  });
  p.log.success(
    brandBody(
      'Grok connected — the access token lives in your OneCLI vault and is refreshed by the host; the container never sees it.',
    ),
  );
}

async function discoverCatalog(accessToken: string): Promise<XaiGrokCatalog> {
  const spinner = p.spinner();
  spinner.start('Reading the Grok model catalog…');
  try {
    const catalog = await fetchXaiGrokOAuthCatalog({ accessToken });
    spinner.stop(`${catalog.models.length} Grok model(s) available.`);
    return catalog;
  } catch (err) {
    spinner.stop('Could not read the Grok model catalog — using the built-in default.', 1);
    setupLog.step('xai-catalog', 'failed', 0, { ERROR: err instanceof Error ? err.message : String(err) });
    return { models: [] };
  }
}

/** Pick the install default model: the catalog when we have one, a free-text id otherwise. */
async function askModel(catalog: XaiGrokCatalog, suggested: string): Promise<string> {
  const OTHER = '__other__';
  if (catalog.models.length > 0) {
    const ordered = [suggested, ...catalog.models.filter((m) => m !== suggested)].filter((m, i, a) =>
      catalog.models.includes(m) ? a.indexOf(m) === i : i === 0,
    );
    const choice = ensureAnswer(
      await brightSelect<string>({
        message: 'Default Grok model for new xai groups? (per group: ncl groups config update --model)',
        options: [
          ...ordered.map((id) => ({
            value: id,
            label: id,
            hint: id === suggested ? 'default for this account' : undefined,
          })),
          { value: OTHER, label: 'Other…', hint: 'type a model id' },
        ],
        initialValue: suggested,
      }),
    );
    if (choice !== OTHER) {
      setupLog.userInput('xai_default_model', choice);
      return choice;
    }
  }
  const typed = ensureAnswer(
    await p.text({
      message: 'Grok model id',
      initialValue: suggested,
      validate: (v) => (v && v.trim() ? undefined : 'Required'),
    }),
  ) as string;
  const model = typed.trim().replace(/^xai\//i, '');
  setupLog.userInput('xai_default_model', model);
  return model;
}

// ─── install verification ────────────────────────────────────────────────

/**
 * Verify the xai payload — and the codex payload it runs on — is fully wired:
 * the same pre-flight the /add-xai skill checks.
 */
export function verifyXaiInstall(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const root = process.cwd();

  const requiredFiles = [
    'src/providers/xai.ts',
    'src/providers/xai-oauth.ts',
    'src/providers/xai-oauth-refresh.ts',
    'src/providers/xai-vault.ts',
    'container/agent-runner/src/providers/xai.ts',
    'container/agent-runner/src/providers/xai-proxy-shim.ts',
    // The codex payload xai composes.
    'src/providers/codex.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  const barrels: Array<[string, string[]]> = [
    ['src/providers/index.ts', ["import './xai.js';", "import './codex.js';"]],
    ['container/agent-runner/src/providers/index.ts', ["import './xai.js';", "import './codex.js';"]],
    ['setup/providers/index.ts', ["import './xai.js';"]],
  ];
  for (const [barrel, lines] of barrels) {
    const barrelPath = path.join(root, barrel);
    const content = fs.existsSync(barrelPath) ? fs.readFileSync(barrelPath, 'utf-8') : '';
    for (const line of lines) {
      if (!content.includes(line)) problems.push(`missing ${line} in ${barrel}`);
    }
  }

  const manifestPath = path.join(root, 'container', 'cli-tools.json');
  let hasCodexCli = false;
  if (fs.existsSync(manifestPath)) {
    try {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      hasCodexCli = Array.isArray(tools) && tools.some((t) => t.name === '@openai/codex');
    } catch {
      hasCodexCli = false;
    }
  }
  if (!hasCodexCli)
    problems.push('container/cli-tools.json missing the @openai/codex CLI entry (xai runs on the Codex runtime)');

  return { ok: problems.length === 0, problems };
}

export async function runXaiInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the xAI provider install…'));
  const { ok, problems } = verifyXaiInstall();
  if (ok) {
    setupLog.step('xai-install', 'success', 0, {});
    p.log.success(brandBody('xAI (Grok) installed properly.'));
    return;
  }
  setupLog.step('xai-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The xAI provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open Claude Code or Codex CLI in this repo and run the /add-xai skill. Setup will continue — xai groups will work once the install completes.',
    ),
  );
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is xai's only reach-in to the setup
// flow (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: 'xai',
  label: 'xAI (Grok)',
  hint: 'SuperGrok subscription (OAuth) or xAI API key — runs on the Codex runtime',
  runAuth: runXaiAuthStep,
  runInstallCheck: runXaiInstallCheck,
});
