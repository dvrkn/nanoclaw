/**
 * Host-side container config for the `xai` provider — Grok on the Codex
 * runtime.
 *
 * xAI's Grok CLI proxy speaks the OpenAI Responses API, which is what the
 * Codex app-server speaks natively, so `xai` composes the codex payload rather
 * than shipping a second agent loop: the contribution runs codex's registered
 * host config (per-group `~/.codex` state, composed AGENTS.md, codex-native
 * skill links — hence `providesAgentSurfaces`) and adds the xAI env the
 * container-side provider turns into a `[model_providers.xai]` block.
 *
 * Credentials: NONE here. The Grok access token (OAuth) or xAI API key lives
 * in the OneCLI vault as a Bearer rewrite keyed to the backend host; codex's
 * traffic already rides the gateway proxy, so the container only ever carries
 * the `placeholder` bearer. The OAuth refresh token is host-only
 * (`data/xai-oauth.json`) and is rotated by the refresher started below.
 */
import { readEnvFile } from '../env.js';
import { onHostStart } from '../host-lifecycle.js';
import { getProviderContainerConfig, registerProviderContainerConfig } from './provider-container-registry.js';
import { XAI_DEFAULT_MODEL_ID, XAI_GROK_CLIENT_VERSION, XAI_GROK_OAUTH_BASE_URL } from './xai-oauth.js';
import { startXaiOAuthRefresher } from './xai-oauth-refresh.js';

/**
 * Non-secret settings the auth walk-through writes to `.env` and the host
 * passes into xai containers. `XAI_BASE_URL` selects the backend the vaulted
 * credential is valid for (Grok proxy for OAuth, `api.x.ai` for an API key).
 */
export const XAI_ENV_PASSTHROUGH = [
  'XAI_BASE_URL',
  'XAI_DEFAULT_MODEL',
  'XAI_GROK_CLIENT_VERSION',
  'XAI_SHIM_DEBUG',
] as const;

export function resolveXaiContainerEnv(
  hostEnv: NodeJS.ProcessEnv,
  dotenv: Record<string, string>,
): Record<string, string> {
  const pick = (key: (typeof XAI_ENV_PASSTHROUGH)[number]): string | undefined => {
    // A real exported variable wins over the .env file, as the opencode payload does.
    const value = hostEnv[key] ?? dotenv[key];
    return value?.trim() ? value.trim() : undefined;
  };
  const debug = pick('XAI_SHIM_DEBUG');
  return {
    XAI_BASE_URL: pick('XAI_BASE_URL') ?? XAI_GROK_OAUTH_BASE_URL,
    XAI_DEFAULT_MODEL: pick('XAI_DEFAULT_MODEL') ?? XAI_DEFAULT_MODEL_ID,
    XAI_GROK_CLIENT_VERSION: pick('XAI_GROK_CLIENT_VERSION') ?? XAI_GROK_CLIENT_VERSION,
    // Opt-in shim diagnostics (shape-only log in the agent workspace); absent by default.
    ...(debug ? { XAI_SHIM_DEBUG: debug } : {}),
  };
}

registerProviderContainerConfig(
  'xai',
  async (ctx) => {
    // Looked up at spawn, not import: barrel order must not matter.
    const codex = getProviderContainerConfig('codex');
    if (!codex) {
      throw new Error(
        'The xai provider runs on the codex payload, which is not wired in this install — apply /add-codex (Install section), then retry.',
      );
    }
    const base = await codex(ctx);
    // The host process does not load `.env` into process.env, so under
    // launchd/systemd ctx.hostEnv carries none of these — read the file.
    const dotenv = readEnvFile([...XAI_ENV_PASSTHROUGH]);
    return {
      mounts: base.mounts,
      env: { ...base.env, ...resolveXaiContainerEnv(ctx.hostEnv, dotenv) },
    };
  },
  { providesAgentSurfaces: true },
);

// Keep the vaulted Grok access token alive for as long as the host runs. The
// refresher is a no-op on installs that use an xAI API key (no credential file).
onHostStart(({ signal }) => {
  startXaiOAuthRefresher(signal);
});
