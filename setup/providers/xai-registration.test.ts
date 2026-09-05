/**
 * Setup-side registration guard for the xai provider (the third barrel of the
 * multi-point archetype): imports the REAL setup/providers barrel and asserts
 * the registry carries xai with its auth + install check. Red if the barrel
 * line is deleted, the barrel fails to evaluate, or the payload module breaks.
 */
import { describe, expect, it } from 'vitest';

import { getSetupProvider } from './registry.js';
import './index.js'; // the real setup provider barrel

describe('xai setup registration', () => {
  it('registers xai with auth + install check via the barrel', () => {
    const xai = getSetupProvider('xai');
    expect(xai).toBeDefined();
    expect(xai!.label).toMatch(/Grok/);
    expect(typeof xai!.runAuth).toBe('function');
    expect(typeof xai!.runInstallCheck).toBe('function');
  });
});
