/**
 * xAI request shim — a localhost HTTP adapter between the Codex app-server
 * and xAI's Responses API.
 *
 * Why it exists. Codex (0.138+) exposes every MCP tool to the model inside a
 * Responses `namespace` tool (`{ type: "namespace", name, tools: [...] }`) and
 * expects the model's calls back as `function_call` items carrying `name` +
 * `namespace`. xAI's Responses implementation — both the Grok CLI proxy and
 * api.x.ai — rejects the `namespace` tool type outright (HTTP 422 "unknown
 * variant namespace"), and Codex offers no switch to flatten: only a provider
 * implementation can turn namespace tools off, and then MCP tools vanish.
 *
 * So Codex is pointed at this shim instead of xAI. Per request the shim:
 *   1. flattens each namespace tool into plain `function` tools named
 *      `<namespace>__<tool>` and rewrites namespaced `function_call` items in
 *      the conversation history the same way;
 *   2. adds the Grok CLI identity headers the proxy requires (proxy host only);
 *   3. forwards to the real backend — through the container's OneCLI proxy
 *      (HTTPS_PROXY), which swaps the placeholder bearer for the vaulted
 *      token, exactly as it would for a direct call;
 *   4. restores `name` + `namespace` on every `function_call` item in the
 *      reply, streamed (SSE) or not, so Codex routes the call to its handler.
 *
 * xAI also implements a narrower Responses request surface than OpenAI. Known
 * gaps are normalized up front (`sanitizeXaiRequestBody`); for the rest the
 * shim reads xAI's own `Argument not supported: <name>` 400 and retries with
 * that argument removed, remembering the name so later requests skip the
 * round trip. Everything else passes through untouched. The shim binds 127.0.0.1 on an
 * ephemeral port and lives inside the agent-runner process.
 */
import fs from 'fs';

export const XAI_GROK_OAUTH_HOST = 'cli-chat-proxy.grok.com';
export const XAI_GROK_CLIENT_VERSION = '1.0.4';
/** Separator between namespace and tool in a flattened function name (Codex's own legacy style). */
export const XAI_FLAT_SEPARATOR = '__';
/** Cap on "drop the named argument and retry" rounds per request. */
const MAX_ARGUMENT_RETRIES = 6;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function log(msg: string): void {
  console.error(`[xai-shim] ${msg}`);
}

// ─── request side: flatten ───────────────────────────────────────────────

export interface FlattenedName {
  namespace: string;
  name: string;
}

export type FlatNameTable = Map<string, FlattenedName>;

export function flattenToolName(namespace: string, name: string): string {
  return `${namespace}${XAI_FLAT_SEPARATOR}${name}`;
}

/**
 * Rewrite a Responses request body: namespace tools → function tools, and
 * namespaced function_call history items → flat names. Returns the table the
 * response side needs to undo the renaming. Non-object bodies pass through.
 */
export function flattenRequestBody(body: unknown): { body: unknown; names: FlatNameTable } {
  const names: FlatNameTable = new Map();
  if (!isRecord(body)) return { body, names };
  const next: Json = { ...body };

  if (Array.isArray(body.tools)) {
    const tools: unknown[] = [];
    for (const tool of body.tools) {
      if (!isRecord(tool) || tool.type !== 'namespace' || !Array.isArray(tool.tools)) {
        tools.push(tool);
        continue;
      }
      const namespace = typeof tool.name === 'string' ? tool.name : '';
      const nsDescription = typeof tool.description === 'string' ? tool.description.trim() : '';
      for (const inner of tool.tools) {
        if (!isRecord(inner) || typeof inner.name !== 'string') continue;
        const flat = flattenToolName(namespace, inner.name);
        names.set(flat, { namespace, name: inner.name });
        const { type: _type, name: _name, ...rest } = inner;
        const description =
          typeof rest.description === 'string' && rest.description.trim() ? rest.description : nsDescription;
        tools.push({ type: 'function', name: flat, ...rest, ...(description ? { description } : {}) });
      }
    }
    next.tools = tools;
  }

  if (Array.isArray(body.input)) {
    next.input = body.input.map((item) => {
      if (!isRecord(item) || item.type !== 'function_call' || typeof item.namespace !== 'string') return item;
      const { namespace, ...rest } = item;
      const flat = typeof rest.name === 'string' ? flattenToolName(namespace, rest.name) : rest.name;
      if (typeof rest.name === 'string') names.set(flat as string, { namespace, name: rest.name });
      return { ...rest, name: flat };
    });
  }

  return { body: next, names };
}

// ─── request side: xAI compatibility ─────────────────────────────────────

/**
 * OpenAI-only request arguments xAI's Responses API is known to refuse; each
 * would otherwise cost a `400 Argument not supported` round trip. Learned
 * names from live rejections are added at runtime (see `rememberRejectedArgument`).
 */
export const XAI_UNSUPPORTED_ARGUMENTS = new Set<string>([
  'prompt_cache_key',
  'prompt_cache_retention',
  'safety_identifier',
  'service_tier',
  // Codex's hosted web_search carries OpenAI's access-scope knobs; xAI's
  // web_search takes the bare type.
  'external_web_access',
  'indexed_web_access',
  // `text.verbosity` is an OpenAI verbosity control.
  'verbosity',
]);

const learnedRejections = new Set<string>();

export function rememberRejectedArgument(name: string): void {
  learnedRejections.add(name);
}

/** Test seam. */
export function _resetLearnedRejectionsForTesting(): void {
  learnedRejections.clear();
}

function withoutKey(value: unknown, name: string): unknown {
  if (!isRecord(value)) return value;
  const next: Json = {};
  for (const [key, inner] of Object.entries(value)) if (key !== name) next[key] = inner;
  return next;
}

/**
 * Remove a request argument by name where xAI validates arguments: the top
 * level, the `reasoning` and `text` objects, and each tool definition. Never
 * inside `input` — conversation items (encrypted reasoning, compaction blobs,
 * tool outputs) are replay data the backend must get back byte-for-byte.
 */
export function deleteArgument(value: unknown, name: string): unknown {
  if (!isRecord(value)) return value;
  const next = withoutKey(value, name) as Json;
  for (const nested of ['reasoning', 'text']) {
    if (isRecord(next[nested])) next[nested] = withoutKey(next[nested], name);
  }
  if (Array.isArray(next.tools)) next.tools = next.tools.map((tool) => withoutKey(tool, name));
  return next;
}

/** Text of a Codex `function_call_output` whose `output` is a content-part array; xAI wants a string. */
function flattenFunctionOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  const parts = output.filter(isRecord);
  const text = parts
    .filter((p) => p.type === 'input_text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  if (text) return text;
  if (parts.some((p) => typeof p.type === 'string' && (p.type as string).includes('image')))
    return '(see attached image)';
  return parts.length ? '(see attached media)' : '';
}

/** Apply the known xAI request normalizations (pure). */
export function sanitizeXaiRequestBody(body: unknown, rejected: ReadonlySet<string> = learnedRejections): unknown {
  if (!isRecord(body)) return body;
  let next: unknown = body;
  for (const name of new Set([...XAI_UNSUPPORTED_ARGUMENTS, ...rejected])) next = deleteArgument(next, name);
  if (!isRecord(next)) return next;
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) =>
      isRecord(item) && item.type === 'function_call_output'
        ? { ...item, output: flattenFunctionOutput(item.output) }
        : item,
    );
  }
  return next;
}

/** Parse xAI's `Argument not supported: <name>` error body; undefined when it is something else. */
export function unsupportedArgumentFrom(errorBody: string): string | undefined {
  const match = /Argument not supported:\s*([A-Za-z0-9_.-]+)/.exec(errorBody);
  return match?.[1];
}

// ─── response side: restore ──────────────────────────────────────────────

export function restoreItem(item: unknown, names: FlatNameTable): unknown {
  if (!isRecord(item) || item.type !== 'function_call' || typeof item.name !== 'string') return item;
  const original = names.get(item.name);
  if (!original) return item;
  return { ...item, name: original.name, namespace: original.namespace };
}

/** Restore names anywhere a Responses payload carries items: `item`, `response.output[]`, `output[]`. */
export function restoreResponseJson(payload: unknown, names: FlatNameTable): unknown {
  if (names.size === 0 || !isRecord(payload)) return payload;
  const next: Json = { ...payload };
  if ('item' in next) next.item = restoreItem(next.item, names);
  if (Array.isArray(next.output)) next.output = next.output.map((i) => restoreItem(i, names));
  if (isRecord(next.response) && Array.isArray(next.response.output)) {
    next.response = { ...next.response, output: next.response.output.map((i) => restoreItem(i, names)) };
  }
  return next;
}

/** Rewrite one SSE line; only `data: {json}` lines change. */
export function restoreSseLine(line: string, names: FlatNameTable): string {
  if (!line.startsWith('data:')) return line;
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') return line;
  try {
    const parsed: unknown = JSON.parse(raw);
    const restored = restoreResponseJson(parsed, names);
    return restored === parsed ? line : `data: ${JSON.stringify(restored)}`;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON data line is forwarded verbatim
  } catch {
    return line;
  }
}

/** Streaming transform: buffers partial lines across chunks, rewrites complete ones. */
export function createSseRestoreTransform(names: FlatNameTable): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        controller.enqueue(encoder.encode(restoreSseLine(line, names) + '\n'));
        newline = buffer.indexOf('\n');
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(restoreSseLine(buffer, names)));
    },
  });
}

// ─── headers ─────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'keep-alive',
]);

export function isXaiGrokOAuthProxy(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === XAI_GROK_OAUTH_HOST;
  } catch {
    return false;
  }
}

/**
 * Outbound headers: the incoming ones minus hop-by-hop, `Accept-Encoding`
 * pinned to identity (SSE is rewritten line by line), plus the Grok CLI
 * identity for the proxy host — with the concrete model the proxy insists on.
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  upstreamBaseUrl: string,
  model: string | undefined,
  clientVersion: string,
): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('accept-encoding', 'identity');
  if (isXaiGrokOAuthProxy(upstreamBaseUrl)) {
    headers.set('X-XAI-Token-Auth', 'xai-grok-cli');
    headers.set('x-grok-client-version', clientVersion);
    if (model) headers.set('x-grok-model-override', model);
  }
  return headers;
}

// ─── server ──────────────────────────────────────────────────────────────

/**
 * Opt-in diagnostics (XAI_SHIM_DEBUG=<path>, or `1` for the default path in the
 * agent workspace, which the host mounts): one JSON line per upstream round
 * trip — shape only (argument names, item types, tool types, status, learned
 * rejections, the start of an error body). Never message text, never headers.
 */
export const XAI_SHIM_DEBUG_DEFAULT_PATH = '/workspace/agent/.xai-shim-debug.log';

export function resolveDebugLogPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.XAI_SHIM_DEBUG?.trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return undefined;
  return raw === '1' || raw.toLowerCase() === 'true' ? XAI_SHIM_DEBUG_DEFAULT_PATH : raw;
}

export function describeRequestShape(body: unknown): Json {
  if (!isRecord(body)) return { body: typeof body };
  const items = Array.isArray(body.input) ? body.input : [];
  return {
    keys: Object.keys(body).sort(),
    reasoning: isRecord(body.reasoning) ? Object.keys(body.reasoning).sort() : undefined,
    text: isRecord(body.text) ? Object.keys(body.text).sort() : undefined,
    include: body.include,
    tools: Array.isArray(body.tools)
      ? body.tools.map((t) =>
          isRecord(t) ? `${String(t.type)}${typeof t.name === 'string' ? `:${t.name}` : ''}` : '?',
        )
      : undefined,
    input: items.map((i) =>
      isRecord(i)
        ? `${String(i.type)}${typeof i.role === 'string' ? `/${i.role}` : ''}${'encrypted_content' in i ? '+enc' : ''}${typeof i.id === 'string' ? '+id' : ''}`
        : '?',
    ),
  };
}

function appendDebug(path: string | undefined, record: Json): void {
  if (!path) return;
  try {
    fs.appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
    // eslint-disable-next-line no-catch-all/no-catch-all -- diagnostics must never break a request
  } catch {
    /* unwritable debug path: drop the line */
  }
}

export interface XaiProxyShimOptions {
  /** Real backend, e.g. https://cli-chat-proxy.grok.com/v1 (trailing /v1 kept). */
  upstreamBaseUrl: string;
  /** Debug log path; defaults to XAI_SHIM_DEBUG resolution. `null` disables. */
  debugLogPath?: string | null;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  /** Outbound proxy URL (the container's OneCLI gateway). Defaults to HTTPS_PROXY/HTTP_PROXY. */
  proxy?: string | null;
  /** Extra CA bundle path for the outbound TLS leg. Defaults to NODE_EXTRA_CA_CERTS. */
  caPath?: string | null;
}

export interface XaiProxyShim {
  /** Base URL Codex should use, with the `/v1` suffix Codex expects. */
  readonly url: string;
  readonly port: number;
  stop(): void;
}

function upstreamUrlFor(upstreamBaseUrl: string, incoming: URL): string {
  const base = upstreamBaseUrl.replace(/\/+$/, '');
  // Codex requests `/v1/<route>` against our base; the upstream base already ends in /v1.
  const path = incoming.pathname.replace(/^\/v1(?=\/|$)/, '');
  return `${base}${path}${incoming.search}`;
}

export function startXaiProxyShim(opts: XaiProxyShimOptions): XaiProxyShim {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientVersion = opts.clientVersion ?? XAI_GROK_CLIENT_VERSION;
  const proxy =
    opts.proxy === undefined ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined : opts.proxy || undefined;
  const caPath = opts.caPath === undefined ? process.env.NODE_EXTRA_CA_CERTS : opts.caPath;
  const debugLogPath = opts.debugLogPath === undefined ? resolveDebugLogPath() : opts.debugLogPath || undefined;
  let ca: string | undefined;
  if (caPath) {
    try {
      ca = fs.readFileSync(caPath, 'utf-8');
      // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable extra CA just means the default trust store is used
    } catch {
      ca = undefined;
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Long model turns stream for minutes; never let the shim time them out.
    idleTimeout: 0,
    async fetch(req) {
      const incoming = new URL(req.url);
      const target = upstreamUrlFor(opts.upstreamBaseUrl, incoming);

      let names: FlatNameTable = new Map();
      let body: BodyInit | undefined;
      let jsonBody: unknown;
      let model: string | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const text = await req.text();
        const contentType = req.headers.get('content-type') ?? '';
        if (text && /json/i.test(contentType)) {
          try {
            const parsed: unknown = JSON.parse(text);
            const flattened = flattenRequestBody(parsed);
            names = flattened.names;
            if (isRecord(parsed) && typeof parsed.model === 'string') model = parsed.model;
            jsonBody = sanitizeXaiRequestBody(flattened.body);
            body = JSON.stringify(jsonBody);
            // eslint-disable-next-line no-catch-all/no-catch-all -- a body we can't parse is forwarded byte-for-byte
          } catch {
            body = text;
          }
        } else {
          body = text;
        }
      }

      const headers = buildUpstreamHeaders(req.headers, opts.upstreamBaseUrl, model, clientVersion);
      const send = async (payload: BodyInit | undefined): Promise<Response> =>
        fetchImpl(target, {
          method: req.method,
          headers,
          body: payload,
          // Bun-specific: route through the container's credential proxy and trust its CA.
          ...({ proxy, ...(ca ? { tls: { ca } } : {}) } as Record<string, unknown>),
        } as RequestInit);

      let upstream: Response;
      const learned: string[] = [];
      try {
        upstream = await send(body);
        // xAI names the offending argument; drop it and retry, a few times at most.
        for (
          let attempt = 0;
          attempt < MAX_ARGUMENT_RETRIES && upstream.status === 400 && jsonBody !== undefined;
          attempt += 1
        ) {
          const errorText = await upstream.clone().text();
          const rejected = unsupportedArgumentFrom(errorText);
          if (!rejected) break;
          rememberRejectedArgument(rejected);
          learned.push(rejected);
          log(`xAI rejected argument "${rejected}" — retrying without it`);
          jsonBody = deleteArgument(jsonBody, rejected);
          body = JSON.stringify(jsonBody);
          upstream = await send(body);
        }
        if (debugLogPath) {
          appendDebug(debugLogPath, {
            method: req.method,
            path: incoming.pathname,
            model,
            status: upstream.status,
            learned,
            request: describeRequestShape(jsonBody),
            ...(upstream.status >= 400 ? { error: (await upstream.clone().text()).slice(0, 600) } : {}),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`upstream request failed: ${message}`);
        return new Response(JSON.stringify({ error: { message: `xai shim: upstream request failed: ${message}` } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }

      const responseHeaders = new Headers(upstream.headers);
      for (const h of ['content-length', 'content-encoding', 'transfer-encoding', 'connection'])
        responseHeaders.delete(h);
      const contentType = upstream.headers.get('content-type') ?? '';

      if (upstream.status >= 400) {
        log(`upstream ${upstream.status} for ${req.method} ${incoming.pathname}`);
      }
      if (names.size === 0 || !upstream.body) {
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
      }
      if (/text\/event-stream/i.test(contentType)) {
        return new Response(upstream.body.pipeThrough(createSseRestoreTransform(names)), {
          status: upstream.status,
          headers: responseHeaders,
        });
      }
      if (/json/i.test(contentType)) {
        const text = await upstream.text();
        try {
          const restored = restoreResponseJson(JSON.parse(text), names);
          return new Response(JSON.stringify(restored), { status: upstream.status, headers: responseHeaders });
          // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON despite the content type: pass it through
        } catch {
          return new Response(text, { status: upstream.status, headers: responseHeaders });
        }
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
  });

  const port = server.port ?? 0;
  log(`listening on 127.0.0.1:${port} → ${opts.upstreamBaseUrl}`);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    stop: () => {
      server.stop(true);
    },
  };
}
