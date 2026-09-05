/**
 * The host refresher's tick, driven against a temp credential file, a fake
 * xAI token endpoint, and a recording vault updater. Covers: not-due is a
 * no-op; a due token is refreshed file-first then vaulted; a failed vault push
 * is retried on a later tick without re-refreshing; a dead grant is recorded
 * once and never retried; a newer login that lands mid-refresh wins.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  XAI_ASSUMED_ACCESS_LIFETIME_MS,
  XAI_REFRESH_MARGIN_MS,
  _resetXaiRefreshLogThrottleForTesting,
  refreshXaiCredentialIfDue,
  xaiRefreshDueAt,
} from './xai-oauth-refresh.js';
import { readXaiCredential, writeXaiCredential, type XaiOAuthCredential } from './xai-oauth.js';

const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const NOW = 1_800_000_000_000;

function credential(overrides: Partial<XaiOAuthCredential> = {}): XaiOAuthCredential {
  return {
    version: 1,
    provider: 'xai',
    authFlow: 'device-code',
    access: 'access-1',
    refresh: 'refresh-1',
    expires: NOW + 60 * 60_000,
    obtainedAt: new Date(NOW - 60_000).toISOString(),
    issuer: 'https://auth.x.ai',
    tokenEndpoint: TOKEN_ENDPOINT,
    deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
    secretId: 'sec-1',
    secretName: 'xAI',
    hostPattern: 'cli-chat-proxy.grok.com',
    vaultAccess: 'access-1',
    ...overrides,
  };
}

function tokenEndpoint(responses: Array<{ status: number; body: unknown }>) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('xAI OAuth refresher tick', () => {
  let dir: string;
  let credentialPath: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const updateSecret = vi.fn<(id: string, value: string) => Promise<void>>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-refresh-'));
    credentialPath = path.join(dir, 'xai-oauth.json');
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
    updateSecret.mockReset();
    updateSecret.mockResolvedValue(undefined);
    _resetXaiRefreshLogThrottleForTesting();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op without a credential file (API-key installs)', async () => {
    const xai = tokenEndpoint([]);
    expect(await refreshXaiCredentialIfDue({ credentialPath, fetchImpl: xai.fetchImpl, updateSecret, logger })).toBe(
      'no-credential',
    );
    expect(xai.calls).toHaveLength(0);
  });

  it('leaves a token alone while it is outside the refresh margin', async () => {
    writeXaiCredential(credential(), credentialPath);
    const xai = tokenEndpoint([]);
    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('fresh');
    expect(xai.calls).toHaveLength(0);
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it('refreshes a due token: rotated pair on disk first, then the vault, then vaultAccess', async () => {
    writeXaiCredential(credential({ expires: NOW + XAI_REFRESH_MARGIN_MS - 1 }), credentialPath);
    const xai = tokenEndpoint([
      { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
    ]);
    const writesSeenByVault: Array<XaiOAuthCredential | null> = [];
    updateSecret.mockImplementation(async () => {
      writesSeenByVault.push(readXaiCredential(credentialPath));
    });

    const outcome = await refreshXaiCredentialIfDue({
      credentialPath,
      fetchImpl: xai.fetchImpl,
      updateSecret,
      logger,
      now: () => NOW,
    });

    expect(outcome).toBe('refreshed');
    expect(xai.calls[0]!.get('grant_type')).toBe('refresh_token');
    expect(xai.calls[0]!.get('refresh_token')).toBe('refresh-1');
    expect(updateSecret).toHaveBeenCalledWith('sec-1', 'access-2');
    // File-first: by the time the vault was called, the rotated refresh token was already persisted.
    expect(writesSeenByVault[0]).toMatchObject({ access: 'access-2', refresh: 'refresh-2', vaultAccess: 'access-1' });
    expect(readXaiCredential(credentialPath)).toMatchObject({
      access: 'access-2',
      refresh: 'refresh-2',
      vaultAccess: 'access-2',
      expires: NOW + 3_600_000,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/rotated in the vault/), expect.anything());
    // The token value itself never reaches a log line.
    for (const call of [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('access-2');
      expect(JSON.stringify(call)).not.toContain('refresh-2');
    }
  });

  it('retries a failed vault push on a later tick without touching xAI again', async () => {
    writeXaiCredential(credential({ expires: NOW + XAI_REFRESH_MARGIN_MS - 1 }), credentialPath);
    const xai = tokenEndpoint([
      { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
    ]);
    updateSecret.mockRejectedValueOnce(new Error('gateway down'));

    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('failed');
    expect(readXaiCredential(credentialPath)).toMatchObject({ access: 'access-2', vaultAccess: 'access-1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/vault rotation failed/), expect.anything());

    // Next tick: not due any more (fresh 1h token), but the vault lags → push only.
    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('vault-synced');
    expect(xai.calls).toHaveLength(1);
    expect(updateSecret).toHaveBeenLastCalledWith('sec-1', 'access-2');
    expect(readXaiCredential(credentialPath)).toMatchObject({ vaultAccess: 'access-2' });
  });

  it('records a dead grant once and stops refreshing until a re-login', async () => {
    writeXaiCredential(credential({ expires: NOW - 1 }), credentialPath);
    const xai = tokenEndpoint([{ status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } }]);

    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('needs-relogin');
    expect(readXaiCredential(credentialPath)?.needsRelogin).toMatch(/invalid_grant/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/provider-auth xai/), expect.anything());

    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('needs-relogin');
    expect(xai.calls).toHaveLength(1);
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it('keeps a newer login that replaced the file while the grant was in flight', async () => {
    writeXaiCredential(credential({ expires: NOW - 1 }), credentialPath);
    const fetchImpl = (async () => {
      // Setup re-login lands mid-refresh: a different grant chain.
      writeXaiCredential(
        credential({ access: 'login-access', refresh: 'login-refresh', vaultAccess: 'login-access' }),
        credentialPath,
      );
      return new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    expect(await refreshXaiCredentialIfDue({ credentialPath, fetchImpl, updateSecret, logger, now: () => NOW })).toBe(
      'fresh',
    );
    expect(readXaiCredential(credentialPath)).toMatchObject({ access: 'login-access', refresh: 'login-refresh' });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it('treats a transient refresh failure as retry-next-tick', async () => {
    writeXaiCredential(credential({ expires: NOW - 1 }), credentialPath);
    const xai = tokenEndpoint([{ status: 503, body: { error: 'temporarily_unavailable' } }]);
    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('failed');
    expect(readXaiCredential(credentialPath)?.needsRelogin).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('warns when the record has no vault secret id to rotate', async () => {
    writeXaiCredential(credential({ expires: NOW - 1, secretId: undefined }), credentialPath);
    const xai = tokenEndpoint([
      { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
    ]);
    expect(
      await refreshXaiCredentialIfDue({
        credentialPath,
        fetchImpl: xai.fetchImpl,
        updateSecret,
        logger,
        now: () => NOW,
      }),
    ).toBe('failed');
    expect(readXaiCredential(credentialPath)).toMatchObject({ access: 'access-2', refresh: 'refresh-2' });
    expect(updateSecret).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no vault secret id/), expect.anything());
  });
});

describe('xaiRefreshDueAt', () => {
  it('uses the expiry minus the margin, or the assumed lifetime when xAI sent no expiry', () => {
    expect(xaiRefreshDueAt({ expires: 1_000_000, obtainedAt: new Date(0).toISOString() })).toBe(
      1_000_000 - XAI_REFRESH_MARGIN_MS,
    );
    expect(xaiRefreshDueAt({ obtainedAt: new Date(5_000).toISOString() })).toBe(
      5_000 + XAI_ASSUMED_ACCESS_LIFETIME_MS - XAI_REFRESH_MARGIN_MS,
    );
  });
});
