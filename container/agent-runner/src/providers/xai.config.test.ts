/**
 * The xai provider's one behavioral difference from codex: the config.toml
 * splice. Drives the real codex writer under a temp HOME, then parses the
 * result with Bun's TOML parser — a top-level `model_provider` that landed
 * inside a table, or a header table the proxy did not get, is red here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexProvider } from './codex.js';
import {
  XAI_API_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
  XAI_GROK_OAUTH_BASE_URL,
  XaiProvider,
  buildXaiModelProviderToml,
  resolveXaiModel,
  writeXaiCodexConfigToml,
} from './xai.js';

const hook = { command: 'bun run /app/memory-hook.ts', legacyCommands: [], sources: ['startup', 'clear', 'compact'] };

interface ParsedToml {
  model_provider?: string;
  model?: string;
  model_providers?: Record<
    string,
    { base_url?: string; wire_api?: string; experimental_bearer_token?: string; http_headers?: Record<string, string> }
  >;
  mcp_servers?: Record<string, { command?: string }>;
  features?: { memories?: boolean };
}

describe('xai config.toml splice', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const readConfig = (): { text: string; parsed: ParsedToml } => {
    const text = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
    return { text, parsed: Bun.TOML.parse(text) as ParsedToml };
  };

  it('selects the xai provider pointed at the shim, keeping codex config intact', () => {
    writeXaiCodexConfigToml(
      { tooling: { command: 'bun', args: ['run', 'tooling.ts'] } },
      hook,
      { model: 'grok-4.5', effort: 'high' },
      { XAI_BASE_URL: XAI_GROK_OAUTH_BASE_URL },
      'http://127.0.0.1:4242/v1',
    );
    const { text, parsed } = readConfig();

    // Top-level selection landed at top level (before the first table header).
    expect(text.indexOf('model_provider = "xai"')).toBeLessThan(text.indexOf('['));
    expect(parsed.model_provider).toBe('xai');
    expect(parsed.model).toBe('grok-4.5');

    const xai = parsed.model_providers?.xai;
    expect(xai).toBeDefined();
    // Codex talks to the localhost shim; the shim owns the backend URL and the Grok headers.
    expect(xai!.base_url).toBe('http://127.0.0.1:4242/v1');
    expect(xai!.wire_api).toBe('responses');
    // The gateway swaps this bearer for the real token on the wire.
    expect(xai!.experimental_bearer_token).toBe('placeholder');
    expect(xai!.http_headers).toBeUndefined();

    // codex's own config survived the splice.
    expect(parsed.mcp_servers?.tooling?.command).toBe('bun');
    expect(parsed.features?.memories).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
  });

  it('resolves the install default model, stripping an xai/ prefix', () => {
    writeXaiCodexConfigToml({}, hook, {}, { XAI_DEFAULT_MODEL: 'xai/grok-4' }, 'http://127.0.0.1:4242/v1');
    const { parsed } = readConfig();
    expect(parsed.model_provider).toBe('xai');
    expect(parsed.model).toBe('grok-4');
  });

  it('falls back to the built-in default model when nothing is configured', () => {
    writeXaiCodexConfigToml({}, hook, {}, {}, 'http://127.0.0.1:4242/v1');
    const { parsed } = readConfig();
    expect(parsed.model).toBe(XAI_DEFAULT_MODEL_ID);
  });

  it('starts a real shim for the configured backend when no Codex URL is injected', () => {
    writeXaiCodexConfigToml({}, hook, {}, { XAI_BASE_URL: XAI_API_BASE_URL });
    const { parsed } = readConfig();
    expect(parsed.model_providers?.xai?.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    // Loopback is excluded from the proxy env codex inherits, or its shim traffic would go through the gateway.
    expect(process.env.NO_PROXY).toContain('127.0.0.1');
    expect(process.env.no_proxy).toContain('localhost');
  });
});

describe('resolveXaiModel', () => {
  it('prefers the group model, then the install default, then the built-in default, stripping an xai/ prefix', () => {
    expect(resolveXaiModel('xai/grok-4.5', { XAI_DEFAULT_MODEL: 'grok-3' })).toBe('grok-4.5');
    expect(resolveXaiModel(undefined, { XAI_DEFAULT_MODEL: 'grok-3' })).toBe('grok-3');
    expect(resolveXaiModel('  ', {})).toBe(XAI_DEFAULT_MODEL_ID);
  });
});

describe('buildXaiModelProviderToml', () => {
  it('emits a parseable provider table with the injected Codex URL and no header table', () => {
    const { tail } = buildXaiModelProviderToml({ baseUrl: 'http://127.0.0.1:1/v1', model: 'grok-4.6' });
    const parsed = Bun.TOML.parse(`model_provider = "xai"\n${tail}`) as ParsedToml;
    expect(parsed.model_providers?.xai?.base_url).toBe('http://127.0.0.1:1/v1');
    expect(parsed.model_providers?.xai?.http_headers).toBeUndefined();
  });
});

describe('XaiProvider', () => {
  it('is the codex provider (inherits effort validation and the memory-hook guard)', () => {
    expect(new XaiProvider({})).toBeInstanceOf(CodexProvider);
    expect(() => new XaiProvider({ effort: 'max' })).toThrow(/Unsupported Codex reasoning effort/);
    expect(() => new XaiProvider({}).query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/not registered/);
  });
});
