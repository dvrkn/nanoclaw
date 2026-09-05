/**
 * The shim that stands between Codex and xAI: namespace tools flattened on the
 * way out, `function_call` names restored on the way back, Grok CLI headers
 * for the proxy host only. Unit-tested on the pure transforms, then end to end
 * against a fake upstream that speaks SSE.
 */
import { afterAll, describe, expect, it } from 'bun:test';

import {
  _resetLearnedRejectionsForTesting,
  buildUpstreamHeaders,
  createSseRestoreTransform,
  deleteArgumentDeep,
  flattenRequestBody,
  flattenToolName,
  restoreResponseJson,
  restoreSseLine,
  sanitizeXaiRequestBody,
  startXaiProxyShim,
  unsupportedArgumentFrom,
} from './xai-proxy-shim.js';

const codexRequest = {
  model: 'grok-4.6',
  store: false,
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', name: 'send_message', namespace: 'mcp__nanoclaw', arguments: '{}', call_id: 'c1' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ],
  tools: [
    { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'mcp__nanoclaw',
      description: 'NanoClaw tools',
      tools: [
        { type: 'function', name: 'send_message', description: 'Send a chat message', parameters: { type: 'object' } },
        { type: 'function', name: 'send_file', description: '', parameters: { type: 'object' }, strict: false },
      ],
    },
    { type: 'web_search' },
  ],
};

describe('request flattening', () => {
  it('turns namespace tools into function tools and flattens namespaced history calls', () => {
    const { body, names } = flattenRequestBody(codexRequest);
    const tools = (body as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.type)).toEqual(['function', 'function', 'function', 'web_search']);
    expect(tools[1]).toEqual({
      type: 'function',
      name: 'mcp__nanoclaw__send_message',
      description: 'Send a chat message',
      parameters: { type: 'object' },
    });
    // An empty tool description inherits the namespace description.
    expect(tools[2]).toMatchObject({ name: 'mcp__nanoclaw__send_file', description: 'NanoClaw tools', strict: false });
    expect(JSON.stringify(body)).not.toContain('"namespace"');

    const input = (body as { input: Array<Record<string, unknown>> }).input;
    expect(input[1]).toEqual({
      type: 'function_call',
      name: 'mcp__nanoclaw__send_message',
      arguments: '{}',
      call_id: 'c1',
    });
    expect(input[2]).toEqual(codexRequest.input[2]);

    expect(names.get(flattenToolName('mcp__nanoclaw', 'send_message'))).toEqual({
      namespace: 'mcp__nanoclaw',
      name: 'send_message',
    });
    // Untouched fields ride along.
    expect((body as { model: string }).model).toBe('grok-4.6');
  });

  it('passes non-JSON and toolless bodies through', () => {
    expect(flattenRequestBody('raw').body).toBe('raw');
    const { body, names } = flattenRequestBody({ model: 'grok-4.6', input: 'hi' });
    expect(body).toEqual({ model: 'grok-4.6', input: 'hi' });
    expect(names.size).toBe(0);
  });
});

describe('xAI request compatibility', () => {
  it('drops known OpenAI-only arguments wherever they sit and flattens tool outputs to strings', () => {
    const body = {
      model: 'grok-4.6',
      prompt_cache_key: 'abc',
      service_tier: 'auto',
      text: { verbosity: 'medium', format: { type: 'text' } },
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [
        { type: 'web_search', external_web_access: true, indexed_web_access: true },
        { type: 'function', name: 'f' },
      ],
      input: [
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [
            { type: 'input_text', text: 'ok ' },
            { type: 'input_text', text: 'done' },
          ],
        },
        { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: 'data:...' }] },
        { type: 'function_call_output', call_id: 'c3', output: 'plain' },
      ],
    };
    const out = sanitizeXaiRequestBody(body, new Set()) as Record<string, any>;
    expect(out.prompt_cache_key).toBeUndefined();
    expect(out.service_tier).toBeUndefined();
    expect(out.text).toEqual({ format: { type: 'text' } });
    // reasoning.effort is supported by the Grok models; only unknown knobs go.
    expect(out.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(out.tools[0]).toEqual({ type: 'web_search' });
    expect(out.input.map((i: { output: unknown }) => i.output)).toEqual(['ok done', '(see attached image)', 'plain']);
    // Learned rejections are honored too.
    expect((sanitizeXaiRequestBody(body, new Set(['summary'])) as any).reasoning).toEqual({ effort: 'high' });
  });

  it("parses xAI's rejection message and deletes the argument deeply", () => {
    expect(unsupportedArgumentFrom('{"code":"400","error":"Argument not supported: external_web_access"}')).toBe(
      'external_web_access',
    );
    expect(unsupportedArgumentFrom('{"error":"something else"}')).toBeUndefined();
    expect(deleteArgumentDeep({ a: 1, nested: { a: 2, b: [{ a: 3, c: 4 }] } }, 'a')).toEqual({
      nested: { b: [{ c: 4 }] },
    });
  });
});

describe('response restoration', () => {
  const { names } = flattenRequestBody(codexRequest);

  it('restores name + namespace on function_call items wherever they appear', () => {
    const call = {
      type: 'function_call',
      name: 'mcp__nanoclaw__send_message',
      arguments: '{"text":"hi"}',
      call_id: 'c2',
    };
    expect(restoreResponseJson({ type: 'response.output_item.done', item: call }, names)).toEqual({
      type: 'response.output_item.done',
      item: { ...call, name: 'send_message', namespace: 'mcp__nanoclaw' },
    });
    expect(restoreResponseJson({ id: 'r', output: [call, { type: 'message' }] }, names)).toMatchObject({
      output: [{ name: 'send_message', namespace: 'mcp__nanoclaw' }, { type: 'message' }],
    });
    expect(restoreResponseJson({ type: 'response.completed', response: { output: [call] } }, names)).toMatchObject({
      response: { output: [{ name: 'send_message', namespace: 'mcp__nanoclaw' }] },
    });
    // A plain (non-namespaced) function keeps its name.
    const shell = { type: 'function_call', name: 'shell_command', arguments: '{}', call_id: 'c3' };
    expect(restoreResponseJson({ item: shell }, names)).toEqual({ item: shell });
  });

  it('rewrites only data: JSON lines of an SSE stream and reassembles chunk-split lines', async () => {
    const event = {
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'mcp__nanoclaw__send_file', arguments: '', call_id: 'c4' },
    };
    const raw = `event: response.output_item.added\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n`;
    expect(restoreSseLine('event: x', names)).toBe('event: x');
    expect(restoreSseLine('data: [DONE]', names)).toBe('data: [DONE]');
    expect(restoreSseLine('data: not json', names)).toBe('data: not json');

    const chunks = [raw.slice(0, 30), raw.slice(30, 75), raw.slice(75)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }).pipeThrough(createSseRestoreTransform(names));
    const text = await new Response(stream).text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: {'))!;
    expect(JSON.parse(dataLine.slice(6))).toEqual({
      ...event,
      item: { ...event.item, name: 'send_file', namespace: 'mcp__nanoclaw' },
    });
    expect(text.endsWith('data: [DONE]\n')).toBe(true);
  });
});

describe('upstream headers', () => {
  it('adds the Grok CLI identity for the proxy host only, drops hop-by-hop, pins identity encoding', () => {
    const incoming = new Headers({
      Authorization: 'Bearer placeholder',
      Host: '127.0.0.1:4242',
      'Content-Length': '99',
      'Accept-Encoding': 'gzip',
      'x-custom': 'kept',
    });
    const proxy = buildUpstreamHeaders(incoming, 'https://cli-chat-proxy.grok.com/v1', 'grok-4.6', '1.0.4');
    expect(proxy.get('authorization')).toBe('Bearer placeholder');
    expect(proxy.get('x-custom')).toBe('kept');
    expect(proxy.has('host')).toBe(false);
    expect(proxy.has('content-length')).toBe(false);
    expect(proxy.get('accept-encoding')).toBe('identity');
    expect(proxy.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(proxy.get('x-grok-client-version')).toBe('1.0.4');
    expect(proxy.get('x-grok-model-override')).toBe('grok-4.6');

    const api = buildUpstreamHeaders(incoming, 'https://api.x.ai/v1', 'grok-4.6', '1.0.4');
    expect(api.has('x-xai-token-auth')).toBe(false);
    expect(api.has('x-grok-model-override')).toBe(false);
  });
});

describe('end to end against a fake upstream', () => {
  const seen: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path: new URL(req.url).pathname, body, headers: req.headers });
      // Mimic xAI: refuse one unknown argument per round trip until the body is clean.
      for (const unsupported of ['truncation', 'metadata']) {
        if (unsupported in body) {
          return new Response(JSON.stringify({ code: '400', error: `Argument not supported: ${unsupported}` }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      const item = {
        type: 'function_call',
        name: 'mcp__nanoclaw__send_message',
        arguments: '{"text":"pong"}',
        call_id: 'c9',
      };
      const sse = [
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [item] } })}\n\n`,
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const shim = startXaiProxyShim({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    proxy: null,
    caPath: null,
  });
  afterAll(() => {
    shim.stop();
    upstream.stop(true);
  });

  it('forwards a flattened request and streams back restored function calls', async () => {
    _resetLearnedRejectionsForTesting();
    const res = await fetch(`${shim.url}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
      body: JSON.stringify({ ...codexRequest, truncation: 'auto', metadata: { a: 1 }, prompt_cache_key: 'k' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();

    // Two rejections learned on the fly, then success: three round trips, the last one clean.
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => 'truncation' in s.body)).toEqual([true, false, false]);
    expect(seen.map((s) => 'metadata' in s.body)).toEqual([true, true, false]);
    // The known-unsupported argument never reached upstream at all.
    expect(seen.every((s) => !('prompt_cache_key' in s.body))).toBe(true);
    const last = seen[2]!;
    expect(last.path).toBe('/v1/responses');
    const tools = last.body.tools as Array<Record<string, unknown>>;
    expect(tools.some((t) => t.type === 'namespace')).toBe(false);
    expect(tools.map((t) => t.name)).toContain('mcp__nanoclaw__send_message');
    expect(last.headers.get('authorization')).toBe('Bearer placeholder');

    // Codex gets its namespaced call back in both the item event and the completion.
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ item: { name: 'send_message', namespace: 'mcp__nanoclaw', call_id: 'c9' } });
    expect(events[1]).toMatchObject({ response: { output: [{ name: 'send_message', namespace: 'mcp__nanoclaw' }] } });
  });

  it('remembers learned rejections so the next request is clean on the first try', async () => {
    seen.length = 0;
    const res = await fetch(`${shim.url}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...codexRequest, truncation: 'auto', metadata: { a: 1 } }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen).toHaveLength(1);
    expect('truncation' in seen[0]!.body).toBe(false);
    expect('metadata' in seen[0]!.body).toBe(false);
  });
});
