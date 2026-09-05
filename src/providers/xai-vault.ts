/**
 * xAI vault access — the OneCLI secret that carries the Grok credential.
 *
 * Gateway-first: the host already reaches OneCLI over HTTP (ONECLI_URL +
 * ONECLI_API_KEY, the same pair the SDK uses), so the secret is listed,
 * created and rotated through the gateway's REST API — `GET/POST /v1/secrets`,
 * `PATCH /v1/secrets/:id` — exactly the calls the `onecli` CLI makes. That
 * matters for a host that itself runs in a container: nothing else in the host
 * runtime shells out to the CLI binary, and this module must not become the
 * reason it has to be installed there.
 *
 * The CLI is the fallback only when no gateway URL is configured (a setup run
 * before the onecli step wrote `.env`). Secret values ride argv or a JSON
 * body, never a shell string and never a log line.
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';

const execFileAsync = promisify(execFile);
const GATEWAY_TIMEOUT_MS = 15_000;

export interface XaiVaultSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

/** A generic secret injected as a header rewrite — the shape both xAI auth modes use. */
export interface XaiVaultCreateInput {
  name: string;
  value: string;
  hostPattern: string;
  headerName: string;
  valueFormat: string;
}

export interface XaiVaultClient {
  readonly transport: 'gateway' | 'cli';
  list(): Promise<XaiVaultSecret[]>;
  /** Returns the new secret's id when the backend reports one. */
  create(input: XaiVaultCreateInput): Promise<string | undefined>;
  /** Rotate the value; `hostPattern` moves the secret to another backend host (our own secret only). */
  update(id: string, value: string, opts?: { hostPattern?: string }): Promise<void>;
}

export interface XaiVaultClientOptions {
  /** Gateway base URL; defaults to ONECLI_URL. Empty/undefined selects the CLI. */
  url?: string | null;
  /** Gateway API key; defaults to ONECLI_API_KEY. Local gateways run without one. */
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /** CLI runner seam: (args) → stdout. Defaults to `onecli <args>` via execFile. */
  runCli?: (args: string[]) => Promise<string>;
}

// ─── shared parsing ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toSecret(row: unknown): XaiVaultSecret | undefined {
  if (!isRecord(row) || typeof row.id !== 'string') return undefined;
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : '',
    type: typeof row.type === 'string' ? row.type : '',
    hostPattern: typeof row.hostPattern === 'string' ? row.hostPattern : null,
  };
}

/** Accepts a bare array (gateway) or a `{ data | secrets: [...] }` envelope (CLI). */
export function parseSecretList(payload: unknown): XaiVaultSecret[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.secrets)
        ? payload.secrets
        : [];
  return rows.map(toSecret).filter((s): s is XaiVaultSecret => Boolean(s));
}

/** Secret id from a create response — the gateway's bare object or the CLI's `{ data }` envelope. */
export function parseCreatedSecretId(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    try {
      return parseCreatedSecretId(JSON.parse(payload));
      // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON CLI output simply yields no id; the caller falls back to a list lookup
    } catch {
      return undefined;
    }
  }
  if (!isRecord(payload)) return undefined;
  const id = payload.id ?? (isRecord(payload.data) ? payload.data.id : undefined);
  return typeof id === 'string' && id.trim() ? id : undefined;
}

// ─── gateway transport ───────────────────────────────────────────────────

function gatewayClient(url: string, apiKey: string | undefined, fetchImpl: typeof fetch): XaiVaultClient {
  const base = url.replace(/\/+$/, '');
  const request = async (method: string, route: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (response.status === 204) return undefined;
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON body is reported through the HTTP status just below
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const detail =
        isRecord(json) && typeof json.error === 'string'
          ? json.error
          : isRecord(json) && typeof json.message === 'string'
            ? json.message
            : text.slice(0, 200);
      throw new Error(`OneCLI gateway ${method} ${route} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return json;
  };

  return {
    transport: 'gateway',
    list: async () => parseSecretList(await request('GET', '/v1/secrets')),
    create: async (input) =>
      parseCreatedSecretId(
        await request('POST', '/v1/secrets', {
          name: input.name,
          type: 'generic',
          value: input.value,
          hostPattern: input.hostPattern,
          injectionConfig: { headerName: input.headerName, valueFormat: input.valueFormat },
        }),
      ),
    update: async (id, value, opts) => {
      await request('PATCH', `/v1/secrets/${encodeURIComponent(id)}`, {
        value,
        ...(opts?.hostPattern ? { hostPattern: opts.hostPattern } : {}),
      });
    },
  };
}

// ─── CLI transport ───────────────────────────────────────────────────────

function cliEnv(): NodeJS.ProcessEnv {
  // The service unit's PATH rarely carries the CLI's install dirs.
  const parts = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin'];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

async function defaultRunCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('onecli', args, { env: cliEnv(), maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function cliClient(runCli: (args: string[]) => Promise<string>): XaiVaultClient {
  return {
    transport: 'cli',
    list: async () => parseSecretList(JSON.parse(await runCli(['secrets', 'list']))),
    create: async (input) =>
      parseCreatedSecretId(
        await runCli([
          'secrets',
          'create',
          '--name',
          input.name,
          '--type',
          'generic',
          '--value',
          input.value,
          '--host-pattern',
          input.hostPattern,
          '--header-name',
          input.headerName,
          '--value-format',
          input.valueFormat,
        ]),
      ),
    update: async (id, value, opts) => {
      await runCli([
        'secrets',
        'update',
        '--id',
        id,
        '--value',
        value,
        ...(opts?.hostPattern ? ['--host-pattern', opts.hostPattern] : []),
      ]);
    },
  };
}

// ─── factory ─────────────────────────────────────────────────────────────

export function createXaiVaultClient(opts: XaiVaultClientOptions = {}): XaiVaultClient {
  const url = (opts.url === undefined ? ONECLI_URL : opts.url)?.trim();
  if (url) {
    const apiKey = (opts.apiKey === undefined ? ONECLI_API_KEY : opts.apiKey)?.trim() || undefined;
    return gatewayClient(url, apiKey, opts.fetchImpl ?? fetch);
  }
  return cliClient(opts.runCli ?? defaultRunCli);
}
