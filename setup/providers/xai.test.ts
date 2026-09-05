import { describe, expect, it, vi } from 'vitest';

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import { findForeignXaiSecrets, findXaiSecret, runXaiDeviceCodeLogin, verifyXaiInstall } from './xai.js';
import { XAI_OAUTH_DISCOVERY_URL } from '../../src/providers/xai-oauth.js';

// Structural guard for the xai payload wiring: provider files, the three
// barrel imports, and the codex payload + CLI pin it runs on. Goes red if any
// of them is removed without going through /add-xai (or its REMOVE.md).
describe('verifyXaiInstall', () => {
  it('passes on a tree with the xai payload wired', () => {
    const { ok, problems } = verifyXaiInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});

// Regression: an operator's own `XAI_API_KEY` secret for api.x.ai was once
// matched by host and overwritten with the OAuth token. Only OUR name counts;
// foreign xAI-host secrets are surfaced, never reused.
describe('findXaiSecret / findForeignXaiSecrets', () => {
  const ours = { id: '1', name: 'xAI', type: 'generic', hostPattern: 'cli-chat-proxy.grok.com' };
  const operatorApiKey = { id: '3', name: 'XAI_API_KEY', type: 'generic', hostPattern: 'api.x.ai' };
  const operatorProxy = { id: '2', name: 'whatever', type: 'generic', hostPattern: 'cli-chat-proxy.grok.com' };
  const other = { id: '4', name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' };

  it('reuses only the secret this walk-through named', () => {
    expect(findXaiSecret([other, operatorApiKey, ours])).toBe(ours);
    expect(findXaiSecret([other, operatorApiKey, operatorProxy])).toBeUndefined();
    expect(findXaiSecret([other])).toBeUndefined();
  });

  it('reports operator-owned secrets on xAI hosts without touching them', () => {
    expect(findForeignXaiSecrets([other, operatorApiKey, operatorProxy, ours])).toEqual([
      operatorApiKey,
      operatorProxy,
    ]);
    expect(findForeignXaiSecrets([other, ours])).toEqual([]);
  });
});

// The device-code walk-through with the terminal abstracted away: the URL and
// one-time code reach the operator before polling starts, the browser is
// pointed at the complete verification URI, and the tokens come back.
describe('runXaiDeviceCodeLogin', () => {
  it('discovers, shows the code, polls, and returns tokens + identity', async () => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64url');
    const idToken = `${b64('{"alg":"none"}')}.${b64(JSON.stringify({ email: 'grok@example.com', sub: 'acct' }))}.s`;
    const tokenEndpoint = 'https://auth.x.ai/oauth2/token';
    const deviceEndpoint = 'https://auth.x.ai/oauth2/device/code';
    const responses: Record<string, unknown[]> = {
      [XAI_OAUTH_DISCOVERY_URL]: [{ token_endpoint: tokenEndpoint, device_authorization_endpoint: deviceEndpoint }],
      [deviceEndpoint]: [
        {
          device_code: 'dev',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?code=WXYZ-1234',
          expires_in: 900,
          interval: 1,
        },
      ],
      [tokenEndpoint]: [
        { error: 'authorization_pending' },
        { access_token: 'access', refresh_token: 'refresh', id_token: idToken, expires_in: 3600 },
      ],
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const queue = responses[String(input)]!;
      const body = queue.length > 1 ? queue.shift()! : queue[0]!;
      const status = (body as { error?: string }).error ? 400 : 200;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const events: string[] = [];
    const result = await runXaiDeviceCodeLogin({
      fetchImpl,
      sleep: async () => {
        events.push('sleep');
      },
      ui: {
        progress: (m) => events.push(`progress:${m}`),
        openUrl: (url) => {
          events.push(`open:${url}`);
          return true;
        },
        showDeviceCode: (info) =>
          events.push(`code:${info.code}@${info.url}:${info.expiresInMinutes}m:${info.openedBrowser}`),
      },
    });

    expect(result.tokens).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
    expect(result.identity).toEqual({ email: 'grok@example.com', accountId: 'acct' });
    expect(result.discovery.tokenEndpoint).toBe(tokenEndpoint);
    expect(events).toEqual([
      'progress:Starting xAI OAuth…',
      'progress:Requesting xAI OAuth device code…',
      'open:https://auth.x.ai/device?code=WXYZ-1234',
      'code:WXYZ-1234@https://auth.x.ai/device:15m:true',
      'progress:Waiting for xAI device authorization…',
      'sleep',
    ]);
  });
});
