/**
 * Integration test for the xai provider's CONTAINER-side reach-in: the
 * self-registration import in container/agent-runner/src/providers/index.ts.
 * Importing the barrel runs xai.ts's top-level registerProvider('xai', …);
 * without that import line createProvider('xai') throws 'Unknown provider' at
 * runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel
 * (./index.js), never ./xai.js directly, then asserts listProviderNames()
 * contains the provider. Red if the barrel import is deleted/drifts, the barrel
 * fails to evaluate, or the codex payload xai composes is missing (the
 * unmocked import throws).
 */
import { describe, expect, it } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('xai provider registration', () => {
  it('registers xai via the provider barrel', () => {
    expect(listProviderNames()).toContain('xai');
  });

  it('runs on the codex payload, which must be registered too', () => {
    expect(listProviderNames()).toContain('codex');
  });
});
