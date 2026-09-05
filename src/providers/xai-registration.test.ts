/**
 * Integration test for the xai provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing the
 * barrel runs xai.ts's top-level registerProviderContainerConfig('xai', …);
 * without that import line the host never wires the provider's contribution
 * and never starts the OAuth refresher.
 *
 * Behavior, not structural, and BARREL-ONLY: imports the real barrel
 * (./index.js), never ./xai.js directly, then asserts the registry contains the
 * provider. Red if the barrel import is deleted/drifts or the barrel fails to
 * evaluate.
 */
import { describe, expect, it } from 'vitest';

import { getHostStartCallbacks } from '../host-lifecycle.js';
import { listProviderContainerConfigNames, providerProvidesAgentSurfaces } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('xai provider host registration', () => {
  it('registers xai host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('xai');
  });

  it('declares its own agent surfaces (it composes codex, whose AGENTS.md replaces the default surfaces)', () => {
    expect(providerProvidesAgentSurfaces('xai')).toBe(true);
  });

  it('registers a host start callback (the OAuth refresher)', () => {
    expect(getHostStartCallbacks().length).toBeGreaterThan(0);
  });
});
