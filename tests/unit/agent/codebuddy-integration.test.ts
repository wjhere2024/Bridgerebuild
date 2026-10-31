import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilityForProfile } from '../../../src/agent/capability';
import { supportedModels } from '../../../src/agent/models';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { agentKindFromString } from '../../../src/config/profile-store';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { SessionCatalog } from '../../../src/session/catalog';

describe('CodeBuddy profile integration', () => {
  it('creates a distinct engine with its own capabilities and model list', () => {
    const profile = createDefaultProfileConfig({ agentKind: 'codebuddy', accounts: { app: { id: 'test-app', secret: 'test-secret', tenant: 'feishu' } } });
    expect(agentKindFromString('codebuddy')).toBe('codebuddy');
    expect(normalizeProfileConfig(profile).agentKind).toBe('codebuddy');
    expect(createRuntimeAgent(profile, { profileDir: tmpdir() }).id).toBe('codebuddy');
    expect(capabilityForProfile(profile)).toMatchObject({ agentId: 'codebuddy', sessionKind: 'codebuddy-session', supportsNativeHistory: false, promptInjection: 'stdin-prefix' });
    expect(supportedModels('codebuddy').map((model) => model.value)).toContain('auto');
    expect(supportedModels('codebuddy').map((model) => model.value)).not.toContain('gpt-5-codex');
  });

  it('persists CodeBuddy sessions separately from Claude and Codex', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codebuddy-catalog-'));
    try {
      const path = join(directory, 'catalog.json');
      const catalog = new SessionCatalog(path);
      const identity = { scopeId: 'chat', agentId: 'codebuddy' as const, cwdRealpath: directory, policyFingerprint: 'policy' };
      catalog.upsertActive({ ...identity, sessionId: 'cb-session' });
      await catalog.flush();
      const reloaded = new SessionCatalog(path);
      await reloaded.load();
      expect(reloaded.activeFor(identity)?.sessionId).toBe('cb-session');
      expect(reloaded.activeFor({ ...identity, agentId: 'claude' })).toBeUndefined();
      expect(reloaded.activeFor({ ...identity, agentId: 'codex' })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
