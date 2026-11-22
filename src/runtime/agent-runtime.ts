import { AntigravityAdapter } from '../agent/antigravity/adapter';
import { CodeBuddyAdapter } from '../agent/codebuddy/adapter';
import { loadAntigravityCatalog, rememberAntigravityModel } from '../agent/antigravity/models';
import { loadCodeBuddyCatalog, rememberCodeBuddyModel } from '../agent/codebuddy/models';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  if (profileConfig.agentKind === 'codebuddy') {
    loadCodeBuddyCatalog(appPaths.profileDir);
    rememberCodeBuddyModel(profileConfig.preferences.model);
    return new CodeBuddyAdapter({ larkChannel });
  }
  if (profileConfig.agentKind === 'antigravity') {
    loadAntigravityCatalog(appPaths.profileDir);
    rememberAntigravityModel(profileConfig.preferences.model);
    const antigravity = profileConfig.antigravity;
    if (!antigravity?.binaryPath) {
      throw new Error('antigravity profile requires antigravity.binaryPath');
    }
    return new AntigravityAdapter({
      binary: antigravity.binaryPath,
      ...(antigravity.project ? { project: antigravity.project } : {}),
      ...(antigravity.model ? { model: antigravity.model } : {}),
      ...(antigravity.printTimeout ? { printTimeout: antigravity.printTimeout } : {}),
      dangerouslySkipPermissions: antigravity.dangerouslySkipPermissions === true,
      sandbox: antigravity.sandbox === true,
      larkChannel,
    });
  }
  return new ClaudeAdapter({ larkChannel });
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId: agent.id === 'codebuddy' ? ('codebuddy' as const) : agent.id === 'codex' ? ('codex' as const) : agent.id === 'antigravity' ? ('antigravity' as const) : ('claude' as const),
    agentName: agent.displayName,
    command: agent.id === 'codebuddy' ? 'codebuddy' : agent.id === 'codex' ? 'codex' : agent.id === 'antigravity' ? 'agy' : 'claude',
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
