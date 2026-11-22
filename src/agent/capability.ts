import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'codebuddy' | 'antigravity';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'codebuddy-session' | 'antigravity-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function capabilityForProfile(profile: ProfileConfig): AgentCapability {
  if (profile.agentKind === 'codex') return codexCapability(profile);
  if (profile.agentKind === 'codebuddy') return {
    ...claudeCapability(profile),
    agentId: 'codebuddy',
    sessionKind: 'codebuddy-session',
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  };
  if (profile.agentKind === 'antigravity') return {
    ...claudeCapability(profile),
    agentId: 'antigravity',
    sessionKind: 'antigravity-session',
    promptInjection: 'stdin-prefix',
    supportsNativeHistory: false,
    callback: { marker: '__bridge_cb', legacyMarkers: [] },
  };
  return claudeCapability(profile);
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}
