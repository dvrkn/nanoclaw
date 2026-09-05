/**
 * xAI (Grok) agent provider — the Codex app-server runtime pointed at xAI.
 *
 * Grok's subscription backend (the Grok CLI proxy at cli-chat-proxy.grok.com)
 * and the pay-per-use API (api.x.ai) both speak the OpenAI Responses API, so
 * this provider IS the codex provider with two differences:
 *   - before every app-server spawn it rewrites the generated
 *     `~/.codex/config.toml` to select a `[model_providers.xai]` entry —
 *     Responses wire API and a placeholder bearer the OneCLI gateway swaps for
 *     the real token on the wire;
 *   - that entry's base URL is a localhost shim (./xai-proxy-shim.ts), not xAI
 *     itself: Codex wraps MCP tools in Responses `namespace` tools, which xAI
 *     rejects, so the shim flattens them on the way out, restores them on the
 *     way back, and adds the Grok CLI identity headers the proxy requires.
 * Model, effort, MCP servers, memory hook, turn loop, archiving: all codex's.
 *
 * Env (set by the host from `.env`, see src/providers/xai.ts):
 *   XAI_BASE_URL            backend the vaulted credential is valid for
 *   XAI_DEFAULT_MODEL       model when the group config names none
 *   XAI_GROK_CLIENT_VERSION `x-grok-client-version` sent to the proxy
 */
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { McpServerConfig, ProviderExchange, ProviderOptions } from './types.js';
import { CodexProvider, type CodexRuntimeDeps } from './codex.js';
import {
  type CodexMemorySessionHook,
  attachCodexAutoApproval,
  initializeCodexAppServer,
  interruptCodexTurn,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  tomlBasicString,
  writeCodexConfigToml,
} from './codex-app-server.js';
import { archiveProviderExchange } from './exchange-archive.js';
import { startXaiProxyShim, type XaiProxyShim } from './xai-proxy-shim.js';

export const XAI_MODEL_PROVIDER_ID = 'xai';
export const XAI_GROK_OAUTH_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_GROK_OAUTH_HOST = 'cli-chat-proxy.grok.com';
export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
export const XAI_DEFAULT_MODEL_ID = 'grok-4.3';
export const XAI_GROK_CLIENT_VERSION = '1.0.4';

/** The env keys this provider reads (`process.env` or a test double). */
export type XaiRuntimeEnv = Readonly<Record<string, string | undefined>>;

export function resolveXaiBaseUrl(env: XaiRuntimeEnv = process.env): string {
  const raw = env.XAI_BASE_URL?.trim();
  return (raw || XAI_GROK_OAUTH_BASE_URL).replace(/\/+$/, '');
}

/**
 * Group model → install default → built-in default. Accepts openclaw-style
 * `xai/<id>` refs so a copied model string works unchanged.
 */
export function resolveXaiModel(model: string | undefined, env: XaiRuntimeEnv = process.env): string {
  const picked = model?.trim() || env.XAI_DEFAULT_MODEL?.trim() || XAI_DEFAULT_MODEL_ID;
  return picked.replace(/^xai\//i, '');
}

/** True for the subscription proxy — the only backend that wants the Grok CLI headers (added by the shim). */
export function isXaiGrokOAuthProxy(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === XAI_GROK_OAUTH_HOST;
  } catch {
    return false;
  }
}

export interface XaiModelProviderTomlOptions {
  /** What Codex calls — the shim's URL in production. */
  baseUrl: string;
  model: string;
}

/**
 * The two pieces spliced into codex's config.toml: `head` is a top-level key
 * (must precede the first table header or TOML re-parents it into that
 * table); `tail` is the provider table, appended after everything else.
 */
export function buildXaiModelProviderToml(opts: XaiModelProviderTomlOptions): { head: string; tail: string } {
  const head = `model_provider = ${tomlBasicString(XAI_MODEL_PROVIDER_ID)}\n`;
  const lines = [
    `[model_providers.${XAI_MODEL_PROVIDER_ID}]`,
    `name = ${tomlBasicString('xAI (Grok)')}`,
    `base_url = ${tomlBasicString(opts.baseUrl)}`,
    `wire_api = ${tomlBasicString('responses')}`,
    // The gateway rewrites the Authorization header for the backend host; the
    // container never holds the real token. Codex's env_key path is unusable
    // here because the app-server's process env is allowlisted (see
    // codex-app-server.ts), so the bearer is configured, not read from env.
    `experimental_bearer_token = ${tomlBasicString('placeholder')}`,
    'requires_openai_auth = false',
    // The Grok CLI identity headers the proxy requires are added per request
    // by the shim (proxy host only), with the concrete model from the body.
  ];
  return { head, tail: lines.join('\n') + '\n' };
}

/**
 * Splice the xai provider selection into an existing codex config.toml.
 * Idempotent on the top-level key (a file that already selects a provider is
 * left as-is there) — codex regenerates the file before every spawn anyway.
 */
export function patchCodexConfigTomlForXai(configTomlPath: string, opts: XaiModelProviderTomlOptions): void {
  const current = fs.readFileSync(configTomlPath, 'utf-8');
  const { head, tail } = buildXaiModelProviderToml(opts);
  const withHead = /^model_provider\s*=/m.test(current) ? current : head + current;
  const separator = withHead.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(configTomlPath, withHead + separator + tail);
}

function mergeNoProxy(current: string | undefined, additions: string): string {
  const parts = new Set(
    (current ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) parts.add(addition.trim());
  return [...parts].join(',');
}

let shim: XaiProxyShim | undefined;
let shimUpstream: string | undefined;

/**
 * One shim per agent-runner process, re-created only if the backend changed.
 * Also excludes loopback from the proxy env: OneCLI's HTTPS_PROXY/HTTP_PROXY
 * reach codex through its env allowlist, and without NO_PROXY the app-server
 * would send its shim traffic through the gateway too.
 */
export function ensureXaiProxyShim(env: XaiRuntimeEnv = process.env): XaiProxyShim {
  const upstream = resolveXaiBaseUrl(env);
  if (shim && shimUpstream === upstream) return shim;
  shim?.stop();
  shim = startXaiProxyShim({
    upstreamBaseUrl: upstream,
    clientVersion: env.XAI_GROK_CLIENT_VERSION?.trim() || undefined,
  });
  shimUpstream = upstream;
  process.env.NO_PROXY = mergeNoProxy(process.env.NO_PROXY, '127.0.0.1,localhost');
  process.env.no_proxy = mergeNoProxy(process.env.no_proxy, '127.0.0.1,localhost');
  return shim;
}

/**
 * codex's config writer, then the xai splice. Same signature as
 * `writeCodexConfigToml` so it drops into `CodexRuntimeDeps`; `codexBaseUrl`
 * (the shim in production) is injectable so config tests bind no port.
 */
export function writeXaiCodexConfigToml(
  servers: Record<string, McpServerConfig>,
  memorySessionHook: CodexMemorySessionHook,
  opts: { model?: string; effort?: string } = {},
  env: XaiRuntimeEnv = process.env,
  codexBaseUrl: string = ensureXaiProxyShim(env).url,
): void {
  const model = resolveXaiModel(opts.model, env);
  writeCodexConfigToml(servers, memorySessionHook, { ...opts, model });
  // Same location codex's writer uses — resolved from the process env, not `env`.
  const configTomlPath = path.join(process.env.HOME || '/home/node', '.codex', 'config.toml');
  patchCodexConfigTomlForXai(configTomlPath, { baseUrl: codexBaseUrl, model });
}

const xaiRuntimeDeps: CodexRuntimeDeps = {
  writeCodexConfigToml: (servers, hook, opts) => writeXaiCodexConfigToml(servers, hook, opts),
  spawnCodexAppServer,
  attachCodexAutoApproval,
  initializeCodexAppServer,
  startOrResumeCodexThread,
  startCodexTurn,
  steerCodexTurn,
  interruptCodexTurn,
  killCodexAppServer,
};

export class XaiProvider extends CodexProvider {
  constructor(options: ProviderOptions = {}, runtime: CodexRuntimeDeps = xaiRuntimeDeps) {
    // Resolve the model here so thread/turn params and the config.toml
    // `model` / `x-grok-model-override` all name the same concrete model.
    super({ ...options, model: resolveXaiModel(options.model, options.env ?? process.env) }, runtime);
  }

  override onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({
      provider: XAI_MODEL_PROVIDER_ID,
      prompt: exchange.prompt,
      result: exchange.result,
      continuation: exchange.continuation,
      status: exchange.status,
    });
  }
}

registerProvider(XAI_MODEL_PROVIDER_ID, (opts) => new XaiProvider(opts));
