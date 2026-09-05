/**
 * Unit coverage for the xAI OAuth client: the device-code dance, refresh
 * semantics (rotation, dead grants, challenge retries, no transport retry),
 * and the host-side credential record. Hermetic — xAI is a fake fetch.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  XAI_GROK_OAUTH_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XaiOAuthError,
  applyRefreshedTokens,
  buildXaiCredential,
  fetchXaiDeviceCodeDiscovery,
  fetchXaiGrokOAuthCatalog,
  isXaiOAuthGrantDead,
  parseXaiOAuthTokenResponse,
  pollXaiDeviceCodeToken,
  readXaiCredential,
  refreshXaiOAuthTokens,
  requestXaiDeviceCode,
  resolveXaiOAuthIdentity,
  writeXaiCredential,
  xaiCredentialPath,
} from './xai-oauth.js';

const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const DEVICE_ENDPOINT = 'https://auth.x.ai/oauth2/device/code';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string): string => Buffer.from(s).toString('base64url');
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(payload))}.sig`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Route = (init: RequestInit & { form: URLSearchParams }) => Response;

/** A scripted xAI: each URL maps to a queue of responses (last one repeats). */
function fakeXai(routes: Record<string, Response[] | Route>) {
  const calls: Array<{ url: string; form: URLSearchParams; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, form, headers });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    if (typeof route === 'function') return route({ ...init, form });
    const next = route.length > 1 ? route.shift()! : route[0]!;
    return next.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const discoveryDoc = {
  token_endpoint: TOKEN_ENDPOINT,
  device_authorization_endpoint: DEVICE_ENDPOINT,
};

describe('xAI OAuth device-code flow', () => {
  it('runs discovery → device code → polls through pending/slow_down → tokens + identity', async () => {
    const access = jwt({ sub: 'acct-1', exp: 4_000_000_000 });
    const idToken = jwt({ email: 'grok@example.com', name: 'Grok Fan', sub: 'acct-1' });
    const xai = fakeXai({
      [XAI_OAUTH_DISCOVERY_URL]: [json(200, discoveryDoc)],
      [DEVICE_ENDPOINT]: [
        json(200, {
          device_code: 'dev-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?code=ABCD-EFGH',
          expires_in: 600,
          interval: 5,
        }),
      ],
      [TOKEN_ENDPOINT]: [
        json(400, { error: 'authorization_pending' }),
        json(400, { error: 'slow_down' }),
        json(200, { access_token: access, refresh_token: 'refresh-1', id_token: idToken, expires_in: 3600 }),
      ],
    });
    const sleeps: number[] = [];
    let clock = 1_000_000;
    const now = (): number => clock;
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    };

    const discovery = await fetchXaiDeviceCodeDiscovery({ fetchImpl: xai.fetchImpl });
    expect(discovery).toEqual({ deviceAuthorizationEndpoint: DEVICE_ENDPOINT, tokenEndpoint: TOKEN_ENDPOINT });

    const device = await requestXaiDeviceCode({
      deviceAuthorizationEndpoint: DEVICE_ENDPOINT,
      fetchImpl: xai.fetchImpl,
    });
    expect(device).toMatchObject({
      deviceCode: 'dev-123',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/device',
      verificationUriComplete: 'https://auth.x.ai/device?code=ABCD-EFGH',
      expiresInMs: 600_000,
      intervalMs: 5_000,
    });
    // The device authorization request carries xAI's shared client id + scopes.
    const deviceCall = xai.calls.find((c) => c.url === DEVICE_ENDPOINT)!;
    expect(deviceCall.form.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID);
    expect(deviceCall.form.get('scope')).toContain('grok-cli:access');
    expect(deviceCall.form.get('scope')).toContain('offline_access');

    const tokens = await pollXaiDeviceCodeToken({
      tokenEndpoint: TOKEN_ENDPOINT,
      deviceCode: device.deviceCode,
      expiresInMs: device.expiresInMs,
      intervalMs: device.intervalMs,
      fetchImpl: xai.fetchImpl,
      now,
      sleep,
    });
    expect(tokens).toMatchObject({ accessToken: access, refreshToken: 'refresh-1', idToken });
    // expires_in wins over the JWT exp, relative to the injected clock.
    expect(tokens.expires).toBe(clock + 3_600_000);
    // pending waits the interval; slow_down grows it by 5s.
    expect(sleeps).toEqual([5_000, 10_000]);
    const grant = xai.calls.filter((c) => c.url === TOKEN_ENDPOINT)[0]!;
    expect(grant.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(grant.form.get('device_code')).toBe('dev-123');

    expect(resolveXaiOAuthIdentity(tokens)).toEqual({
      email: 'grok@example.com',
      displayName: 'Grok Fan',
      accountId: 'acct-1',
    });
  });

  it('refuses discovery documents that point off x.ai or off https', async () => {
    const offHost = fakeXai({
      [XAI_OAUTH_DISCOVERY_URL]: [
        json(200, { token_endpoint: 'https://evil.example/token', device_authorization_endpoint: DEVICE_ENDPOINT }),
      ],
    });
    await expect(fetchXaiDeviceCodeDiscovery({ fetchImpl: offHost.fetchImpl })).rejects.toThrow(
      /untrusted token endpoint/,
    );
    const plainHttp = fakeXai({
      [XAI_OAUTH_DISCOVERY_URL]: [
        json(200, { token_endpoint: TOKEN_ENDPOINT, device_authorization_endpoint: 'http://auth.x.ai/device' }),
      ],
    });
    await expect(fetchXaiDeviceCodeDiscovery({ fetchImpl: plainHttp.fetchImpl })).rejects.toThrow(/untrusted device/);
  });

  it('surfaces denial and expiry as structured errors and requires a refresh token', async () => {
    const poll = (responses: Response[]) =>
      pollXaiDeviceCodeToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        deviceCode: 'dev',
        expiresInMs: 60_000,
        intervalMs: 1_000,
        fetchImpl: fakeXai({ [TOKEN_ENDPOINT]: responses }).fetchImpl,
        sleep: async () => {},
      });
    await expect(poll([json(400, { error: 'access_denied' })])).rejects.toMatchObject({ code: 'access_denied' });
    await expect(poll([json(400, { error: 'expired_token' })])).rejects.toThrow(/expired/);
    await expect(poll([json(200, { access_token: 'a' })])).rejects.toThrow(/missing refresh_token/);
  });

  it('times out when the device code expires before approval', async () => {
    let clock = 0;
    await expect(
      pollXaiDeviceCodeToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        deviceCode: 'dev',
        expiresInMs: 10_000,
        intervalMs: 5_000,
        fetchImpl: fakeXai({ [TOKEN_ENDPOINT]: [json(400, { error: 'authorization_pending' })] }).fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('xAI OAuth refresh', () => {
  it('rotates the pair on success', async () => {
    const xai = fakeXai({
      [TOKEN_ENDPOINT]: [json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 })],
    });
    const tokens = await refreshXaiOAuthTokens({
      tokenEndpoint: TOKEN_ENDPOINT,
      refreshToken: 'refresh-1',
      fetchImpl: xai.fetchImpl,
      now: () => 1_000,
    });
    expect(tokens).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2', expires: 1_801_000 });
    const form = xai.calls[0]!.form;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-1');
    expect(form.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID);
  });

  it('treats invalid_grant as final — one request, a dead-grant error', async () => {
    const xai = fakeXai({ [TOKEN_ENDPOINT]: [json(400, { error: 'invalid_grant', error_description: 'revoked' })] });
    const err = await refreshXaiOAuthTokens({
      tokenEndpoint: TOKEN_ENDPOINT,
      refreshToken: 'r',
      fetchImpl: xai.fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XaiOAuthError);
    expect((err as XaiOAuthError).code).toBe('invalid_grant');
    expect(isXaiOAuthGrantDead(err)).toBe(true);
    expect(xai.calls).toHaveLength(1);
  });

  it('retries a Cloudflare challenge page, then gives up as retryable', async () => {
    const challenge = (): Response =>
      new Response('<!doctype html><title>Just a moment...</title>', {
        status: 403,
        headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
      });
    const xai = fakeXai({ [TOKEN_ENDPOINT]: [challenge(), challenge(), challenge()] });
    const err = await refreshXaiOAuthTokens({
      tokenEndpoint: TOKEN_ENDPOINT,
      refreshToken: 'r',
      fetchImpl: xai.fetchImpl,
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XaiOAuthError);
    expect((err as XaiOAuthError).retryable).toBe(true);
    expect((err as XaiOAuthError).message).toMatch(/Cloudflare/);
    expect(isXaiOAuthGrantDead(err)).toBe(false);
    expect(xai.calls).toHaveLength(3);
  });

  it('never resends a refresh grant after a transport failure (the token may already be consumed)', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(
      refreshXaiOAuthTokens({ tokenEndpoint: TOKEN_ENDPOINT, refreshToken: 'r', fetchImpl }),
    ).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(1);
  });
});

describe('token response parsing', () => {
  it('falls back to the access-token JWT exp when expires_in is absent', () => {
    const access = jwt({ exp: 1_700_000_000 });
    expect(parseXaiOAuthTokenResponse({ access_token: access }, () => 0).expires).toBe(1_700_000_000_000);
  });

  it('rejects a response without an access token', () => {
    expect(() => parseXaiOAuthTokenResponse({}, () => 0)).toThrow(/missing access_token/);
  });
});

describe('Grok OAuth catalog', () => {
  it('lists language models, drops image backends, reads the account default, and sends the CLI identity', async () => {
    const xai = fakeXai({
      [`${XAI_GROK_OAUTH_BASE_URL}/models`]: [
        json(200, {
          data: [
            { id: 'grok-4.3', api_backend: 'responses' },
            { id: 'grok-build-0.1', api_backend: 'chat' },
            { id: 'grok-imagine-image', api_backend: 'image' },
            { id: 'grok-video', api_backend: 'video' },
          ],
        }),
      ],
      [`${XAI_GROK_OAUTH_BASE_URL}/settings`]: [json(200, { default_model: 'grok-build-0.1' })],
    });
    const catalog = await fetchXaiGrokOAuthCatalog({ accessToken: 'tok', fetchImpl: xai.fetchImpl });
    expect(catalog).toEqual({ models: ['grok-4.3', 'grok-build-0.1'], defaultModel: 'grok-build-0.1' });
    const headers = xai.calls[0]!.headers;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['x-xai-token-auth']).toBe('xai-grok-cli');
    expect(headers['x-grok-client-version']).toBeTruthy();
  });

  it('keeps the model list when the settings hint fails', async () => {
    const xai = fakeXai({
      [`${XAI_GROK_OAUTH_BASE_URL}/models`]: [json(200, { data: [{ id: 'grok-4.3' }] })],
      [`${XAI_GROK_OAUTH_BASE_URL}/settings`]: [json(500, { error: 'boom' })],
    });
    expect(await fetchXaiGrokOAuthCatalog({ accessToken: 'tok', fetchImpl: xai.fetchImpl })).toEqual({
      models: ['grok-4.3'],
    });
  });
});

describe('credential record', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through an owner-only file and marks the vaulted access token', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-cred-'));
    const file = xaiCredentialPath(dir);
    const cred = buildXaiCredential({
      tokens: { accessToken: 'a1', refreshToken: 'r1', expires: 123, idToken: jwt({ email: 'e@x.ai', sub: 's' }) },
      discovery: { tokenEndpoint: TOKEN_ENDPOINT, deviceAuthorizationEndpoint: DEVICE_ENDPOINT },
      secretId: 'sec-1',
      vaulted: true,
      now: () => 5_000,
    });
    expect(cred).toMatchObject({
      version: 1,
      provider: 'xai',
      authFlow: 'device-code',
      access: 'a1',
      refresh: 'r1',
      expires: 123,
      email: 'e@x.ai',
      accountId: 's',
      secretId: 'sec-1',
      vaultAccess: 'a1',
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    writeXaiCredential(cred, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readXaiCredential(file)).toEqual(cred);
    expect(fs.readdirSync(dir)).toEqual(['xai-oauth.json']); // no temp file left behind
  });

  it('returns null when absent and rejects foreign records', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-cred-'));
    const file = xaiCredentialPath(dir);
    expect(readXaiCredential(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ tokens: {} }));
    expect(() => readXaiCredential(file)).toThrow(/not a NanoClaw xAI OAuth credential/);
  });

  it('applies a refresh: rotates, keeps the old refresh token when none came back, clears needsRelogin', () => {
    const base = buildXaiCredential({
      tokens: { accessToken: 'a1', refreshToken: 'r1', expires: 1 },
      discovery: { tokenEndpoint: TOKEN_ENDPOINT, deviceAuthorizationEndpoint: DEVICE_ENDPOINT },
    });
    const rotated = applyRefreshedTokens(
      { ...base, needsRelogin: 'x' },
      { accessToken: 'a2', refreshToken: 'r2', expires: 2 },
      () => 10_000,
    );
    expect(rotated).toMatchObject({
      access: 'a2',
      refresh: 'r2',
      expires: 2,
      obtainedAt: new Date(10_000).toISOString(),
    });
    expect(rotated.needsRelogin).toBeUndefined();
    const kept = applyRefreshedTokens(base, { accessToken: 'a3' });
    expect(kept.refresh).toBe('r1');
    expect(kept.expires).toBeUndefined();
  });
});
