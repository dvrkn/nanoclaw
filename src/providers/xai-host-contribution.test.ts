/**
 * In-process seam test for the xai HOST contribution's runtime consumption of
 * core: drive the REAL registered contribution — via the real barrel and
 * registry, never by importing xai.ts's internals — against a real test DB and
 * a temp GROUPS_DIR/DATA_DIR, then hand its result to the real buildMounts.
 *
 * xai composes the codex contribution, so this is also what catches drift in
 * that composition: the codex state dir + AGENTS.md mounts must come through,
 * the default Claude surfaces must not, and the xAI env must be layered on top.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-xai-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-xai-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-xai-host-contribution-test/groups',
}));

import { buildMounts } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { resolveXaiContainerEnv } from './xai.js';
import { XAI_DEFAULT_MODEL_ID, XAI_GROK_CLIENT_VERSION, XAI_GROK_OAUTH_BASE_URL } from './xai-oauth.js';
import './index.js'; // the real host provider barrel
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

describe('xai host contribution against real core', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('composes the codex contribution and layers the xAI backend env on top', async () => {
    const ag = group('ag-xai', 'xai-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);

    const contributionFn = getProviderContainerConfig('xai');
    expect(contributionFn).toBeDefined();
    // Host env deliberately blank: the defaults are the OAuth proxy + built-in model.
    const hostEnv = { ...process.env };
    delete hostEnv.XAI_BASE_URL;
    delete hostEnv.XAI_DEFAULT_MODEL;
    delete hostEnv.XAI_GROK_CLIENT_VERSION;
    const contribution = await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv,
    });

    // codex's per-group state dir came through (with the OneCLI auth stub pre-created).
    const codexShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.codex-shared');
    expect(fs.existsSync(path.join(codexShared, 'auth.json'))).toBe(true);
    expect(contribution.mounts?.find((m) => m.containerPath === '/home/node/.codex')).toMatchObject({
      hostPath: codexShared,
      readonly: false,
    });
    // codex's composed project document exists for the mount.
    expect(fs.existsSync(path.join(groupDir, 'AGENTS.md'))).toBe(true);

    // The xAI backend selection rides env — never a credential.
    expect(contribution.env).toMatchObject({
      XAI_BASE_URL: XAI_GROK_OAUTH_BASE_URL,
      XAI_DEFAULT_MODEL: XAI_DEFAULT_MODEL_ID,
      XAI_GROK_CLIENT_VERSION,
    });
    for (const key of Object.keys(contribution.env ?? {})) {
      expect(key).not.toMatch(/KEY|TOKEN|SECRET/i);
    }

    // The full mount set: codex surfaces in, default claude surfaces out.
    const session = { id: 'session-1', agent_group_id: ag.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(ag, session, config, 'xai', contribution);
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/home/node/.codex');
    expect(containerPaths.some((p) => p.endsWith('AGENTS.md'))).toBe(true);
    expect(containerPaths).not.toContain('/home/node/.claude');
  });

  it('prefers an exported host variable over the .env file, and the file over the default', () => {
    expect(
      resolveXaiContainerEnv({ XAI_BASE_URL: 'https://api.x.ai/v1' }, { XAI_BASE_URL: 'https://other.example/v1' }),
    ).toMatchObject({ XAI_BASE_URL: 'https://api.x.ai/v1' });
    expect(resolveXaiContainerEnv({}, { XAI_DEFAULT_MODEL: 'grok-4.5' })).toMatchObject({
      XAI_DEFAULT_MODEL: 'grok-4.5',
    });
    expect(resolveXaiContainerEnv({ XAI_DEFAULT_MODEL: '   ' }, {})).toMatchObject({
      XAI_DEFAULT_MODEL: XAI_DEFAULT_MODEL_ID,
    });
  });
});
