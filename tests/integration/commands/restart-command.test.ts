import { describe, expect, it, vi } from 'vitest';
import { handleRestart } from '../../../src/commands/restart';
import { tryHandleCommand, type CommandContext } from '../../../src/commands';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const state = vi.hoisted(() => ({ exists: true, pid: 0 }));
vi.mock('../../../src/daemon/service-adapter', () => ({ getServiceAdapter: () => ({
  fileExists: () => state.exists, isRunning: () => true,
  describeStatus: () => '', parseStatus: () => ({ pid: String(state.pid) }),
}) }));

function context(): CommandContext {
  const profileConfig = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex' }, accounts: { app: { id: 'fixture', secret: '${FIXTURE}', tenant: 'feishu' } } });
  return {
    channel: { send: vi.fn(async () => ({ messageId: 'om_fixture' })) },
    msg: { content: '/restart', senderId: 'ou_admin', chatId: 'oc_test', messageId: 'om_test' },
    activeRuns: new ActiveRuns(), chatMode: 'p2p',
    controls: { profile: 'codex', profileConfig, botOwnerId: 'ou_admin', ownerRefreshState: 'ok', processId: 'fixture', exit: vi.fn(async () => {}) },
  } as unknown as CommandContext;
}

describe('restored process restart command', () => {
  it('replies before gracefully exiting a process owned by its service', async () => {
    state.exists = true; state.pid = process.pid;
    const ctx = context(); await handleRestart('', ctx);
    expect(ctx.channel.send).toHaveBeenCalledOnce();
    expect(ctx.controls.exit).toHaveBeenCalledOnce();
    expect(vi.mocked(ctx.channel.send).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(ctx.controls.exit).mock.invocationCallOrder[0]!);
  });
  it('keeps a foreground process alive even if a service for the same profile exists', async () => {
    state.exists = true; state.pid = process.pid + 1;
    const ctx = context(); await handleRestart('', ctx);
    expect(ctx.controls.exit).not.toHaveBeenCalled();
  });
  it('keeps a process without a service alive', async () => {
    state.exists = false; state.pid = process.pid;
    const ctx = context(); await handleRestart('', ctx);
    expect(ctx.controls.exit).not.toHaveBeenCalled();
  });
  it('rejects non-admin restart requests', async () => {
    state.exists = true; state.pid = process.pid;
    const ctx = context(); ctx.msg.senderId = 'ou_other'; await tryHandleCommand(ctx);
    expect(ctx.controls.exit).not.toHaveBeenCalled();
  });
});
