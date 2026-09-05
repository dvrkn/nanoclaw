/**
 * The vault client behind the xAI sign-in and refresher: gateway REST when a
 * gateway URL is configured (the path a containerized host relies on — no
 * `onecli` binary involved), the CLI otherwise. Hermetic: fake fetch, fake CLI.
 */
import { describe, expect, it, vi } from 'vitest';

import { createXaiVaultClient, parseCreatedSecretId, parseSecretList } from './xai-vault.js';

function fakeGateway(handler: (req: { method: string; url: string; headers: Headers; body: unknown }) => Response) {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('gateway transport', () => {
  it('lists, creates and rotates through /v1/secrets with Bearer auth, never a shell', async () => {
    const gw = fakeGateway((req) => {
      if (req.method === 'GET') return json(200, [{ id: 's1', name: 'xAI', type: 'generic', hostPattern: 'api.x.ai' }]);
      if (req.method === 'POST')
        return json(201, { id: 's2', name: 'xAI', type: 'generic', hostPattern: 'cli-chat-proxy.grok.com' });
      if (req.method === 'PATCH') return new Response(null, { status: 204 });
      return json(500, { error: 'unexpected' });
    });
    const vault = createXaiVaultClient({ url: 'http://127.0.0.1:10254/', apiKey: 'key-1', fetchImpl: gw.fetchImpl });
    expect(vault.transport).toBe('gateway');

    expect(await vault.list()).toEqual([{ id: 's1', name: 'xAI', type: 'generic', hostPattern: 'api.x.ai' }]);
    expect(
      await vault.create({
        name: 'xAI',
        value: 'tok-1',
        hostPattern: 'cli-chat-proxy.grok.com',
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      }),
    ).toBe('s2');
    await vault.update('s2', 'tok-2');

    expect(gw.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://127.0.0.1:10254/v1/secrets',
      'POST http://127.0.0.1:10254/v1/secrets',
      'PATCH http://127.0.0.1:10254/v1/secrets/s2',
    ]);
    for (const call of gw.calls) expect(call.headers.get('authorization')).toBe('Bearer key-1');
    expect(gw.calls[1]!.body).toEqual({
      name: 'xAI',
      type: 'generic',
      value: 'tok-1',
      hostPattern: 'cli-chat-proxy.grok.com',
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
    expect(gw.calls[2]!.body).toEqual({ value: 'tok-2' });
    expect(gw.calls[2]!.headers.get('content-type')).toBe('application/json');
  });

  it('moves our secret to another backend host when asked (auth-mode switch)', async () => {
    const gw = fakeGateway(() => new Response(null, { status: 204 }));
    await createXaiVaultClient({ url: 'http://localhost:10254', apiKey: null, fetchImpl: gw.fetchImpl }).update(
      's1',
      'tok',
      { hostPattern: 'api.x.ai' },
    );
    expect(gw.calls[0]!.body).toEqual({ value: 'tok', hostPattern: 'api.x.ai' });
  });

  it('omits the Authorization header for a keyless local gateway', async () => {
    const gw = fakeGateway(() => json(200, []));
    await createXaiVaultClient({ url: 'http://localhost:10254', apiKey: '', fetchImpl: gw.fetchImpl }).list();
    expect(gw.calls[0]!.headers.has('authorization')).toBe(false);
  });

  it('surfaces gateway errors with status and message, without the secret value', async () => {
    const gw = fakeGateway(() => json(404, { error: 'secret not found' }));
    const vault = createXaiVaultClient({ url: 'http://localhost:10254', apiKey: null, fetchImpl: gw.fetchImpl });
    await expect(vault.update('missing', 'super-secret-token')).rejects.toThrow(
      /PATCH \/v1\/secrets\/missing failed \(404\): secret not found/,
    );
    await expect(vault.update('missing', 'super-secret-token')).rejects.not.toThrow(/super-secret-token/);
  });
});

describe('CLI fallback', () => {
  it('is selected when no gateway URL is configured and drives `onecli secrets …` by argv', async () => {
    const runCli = vi.fn<(args: string[]) => Promise<string>>();
    runCli.mockResolvedValueOnce(
      JSON.stringify({ data: [{ id: 'c1', name: 'xAI', type: 'generic', hostPattern: null }] }),
    );
    runCli.mockResolvedValueOnce(JSON.stringify({ data: { id: 'c2' } }));
    runCli.mockResolvedValueOnce(JSON.stringify({ status: 'updated', id: 'c2' }));
    const vault = createXaiVaultClient({ url: '', runCli });
    expect(vault.transport).toBe('cli');

    expect(await vault.list()).toEqual([{ id: 'c1', name: 'xAI', type: 'generic', hostPattern: null }]);
    expect(
      await vault.create({
        name: 'xAI',
        value: 'tok',
        hostPattern: 'api.x.ai',
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      }),
    ).toBe('c2');
    await vault.update('c2', 'tok-2');
    runCli.mockResolvedValueOnce('{}');
    await vault.update('c2', 'tok-3', { hostPattern: 'api.x.ai' });

    expect(runCli.mock.calls[0]![0]).toEqual(['secrets', 'list']);
    expect(runCli.mock.calls[3]![0]).toEqual([
      'secrets',
      'update',
      '--id',
      'c2',
      '--value',
      'tok-3',
      '--host-pattern',
      'api.x.ai',
    ]);
    expect(runCli.mock.calls[1]![0]).toEqual([
      'secrets',
      'create',
      '--name',
      'xAI',
      '--type',
      'generic',
      '--value',
      'tok',
      '--host-pattern',
      'api.x.ai',
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    ]);
    expect(runCli.mock.calls[2]![0]).toEqual(['secrets', 'update', '--id', 'c2', '--value', 'tok-2']);
  });
});

describe('response parsing', () => {
  it('reads a secret list from a bare array or an envelope, dropping malformed rows', () => {
    const rows = [{ id: 'a', name: 'n', type: 't', hostPattern: 'h' }, { nope: true }];
    expect(parseSecretList(rows)).toHaveLength(1);
    expect(parseSecretList({ data: rows })).toHaveLength(1);
    expect(parseSecretList({ secrets: rows })).toHaveLength(1);
    expect(parseSecretList('garbage')).toEqual([]);
  });

  it('reads the created id from either envelope shape, JSON text included', () => {
    expect(parseCreatedSecretId({ id: 'x' })).toBe('x');
    expect(parseCreatedSecretId({ data: { id: 'y' } })).toBe('y');
    expect(parseCreatedSecretId('{"data":{"id":"z"}}')).toBe('z');
    expect(parseCreatedSecretId('Created.')).toBeUndefined();
    expect(parseCreatedSecretId({ id: '  ' })).toBeUndefined();
  });
});
