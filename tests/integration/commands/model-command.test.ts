import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { handleCardAction } from '../../../src/card/dispatcher';
import { runCommandHandler, tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema';
import { runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store';
import { CodexModelStore } from '../../../src/model/registry';
import { ClaudeModelStore } from '../../../src/model/claude-registry';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(agentKind: 'codex' | 'claude' = 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-model-command-'));
  const codexDir = join(dir, 'codex');
  await mkdir(codexDir);
  await writeFile(join(codexDir, 'config.toml'), 'model_provider = "alpha"\nmodel = "OldModel"\n[projects."/workspace"]\ntrust_level = "trusted"\n');
  await writeFile(join(codexDir, 'auth.json'), '{"OPENAI_API_KEY":"fixture-old-key"}');
  await writeFile(join(codexDir, 'model-registry.json'), JSON.stringify({ version: 1, current: { key: 'alpha', model: 'OldModel' }, keys: {
    alpha: { baseUrl: 'https://alpha.test/v1', auth: { OPENAI_API_KEY: 'fixture-old-key' }, models: ['OldModel'] },
    beta: { baseUrl: 'https://beta.test/v1', auth: { OPENAI_API_KEY: 'fixture-new-key' }, models: ['Vendor/NewModel'] },
  } }));
  if (agentKind === 'claude') {
    vi.stubEnv('CLAUDE_CONFIG_DIR', codexDir);
    await writeFile(join(codexDir, 'settings.json'), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: 'https://alpha.test/v1', ANTHROPIC_AUTH_TOKEN: 'fixture-old-key', ANTHROPIC_MODEL: 'OldModel',
    } }));
    const registry = JSON.parse(await readFile(join(codexDir, 'model-registry.json'), 'utf8'));
    for (const entry of Object.values(registry.keys) as Array<{ auth: Record<string, string> }>) {
      entry.auth = { ANTHROPIC_AUTH_TOKEN: entry.auth.OPENAI_API_KEY! };
    }
    await writeFile(join(codexDir, 'model-registry.json'), JSON.stringify(registry));
  }
  const root: RootConfig = {
    schemaVersion: 2, activeProfile: 'codex', preferences: {}, profiles: {
      codex: createDefaultProfileConfig({ agentKind: 'codex',
        accounts: { app: { id: 'fixture-app', secret: '${FIXTURE_SECRET}', tenant: 'feishu' } },
        access: { admins: ['ou_admin'], allowedUsers: ['ou_member'], allowedChats: ['oc_test'] },
        codex: { codexHome: codexDir, binaryPath: 'codex' },
      }),
      claude: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'fixture-other', secret: '${FIXTURE_SECRET}', tenant: 'feishu' } } }),
    },
  };
  root.profiles.codex!.preferences.model = 'gpt-5.6-sol';
  if (agentKind === 'claude') root.profiles.claude!.preferences.model = 'OldOverride';
  await saveRootConfig(root, join(dir, 'config.json'));
  const persistedRoot = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as RootConfig;
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(dir, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const pending = new PendingQueue(60_000, () => {});
  const controls: Controls = {
    profile: agentKind, profileConfig: root.profiles[agentKind]!, cfg: runtimeProfileConfig(root, agentKind),
    configPath: join(dir, 'config.json'), processId: 'fixture-process', botOwnerId: 'ou_admin', ownerRefreshState: 'ok',
    async refreshOwner() {}, async restart() {}, async exit() {},
  };
  const ctx: CommandContext = {
    channel: channel as unknown as CommandContext['channel'], controls, sessions, workspaces,
    scope: 'oc_test', chatMode: 'p2p', activeRuns: new ActiveRuns(), agent: new FakeAgentAdapter(),
    msg: { messageId: 'om_test', chatId: 'oc_test', chatType: 'p2p', senderId: 'ou_admin',
      content: '', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now() } as NormalizedMessage,
  };
  cleanups.push(async () => { pending.cancelAll(); await sessions.flush(); await workspaces.flush(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, codexDir, root: persistedRoot, ctx, channel, store: agentKind === 'claude' ? new ClaudeModelStore(codexDir) : new CodexModelStore(codexDir),
    async command(content: string) { ctx.msg.content = content; return tryHandleCommand(ctx); },
    async callback(value: Record<string, unknown>, options: { option?: string; formValue?: Record<string, unknown>; raw?: unknown; operator?: string } = {}) {
      return handleCardAction({
        ...ctx, pending,
        evt: { chatId: 'oc_test', messageId: 'om_card', operator: { openId: options.operator ?? ctx.msg.senderId, name: 'Fixture' },
          action: { value, option: options.option, formValue: options.formValue }, raw: options.raw } as CardActionEvent,
        chatModeCache: { resolve: async () => ctx.chatMode } as never,
      });
    },
    visible() { return JSON.stringify(channel.sent.map((sent) => sent.content)); },
  };
}

describe('restored /model commands and cards', () => {
  it.each(['codex', 'claude'] as const)('adds manual %s models from cards and text without switching the session', async (agentKind) => {
    const h = await harness(agentKind);
    h.ctx.sessions.set('oc_test', 'keep-session', '/workspace');
    await h.command('/model');
    expect(h.visible()).toContain('添加模型');
    await h.callback({ cmd: 'model.add-model', arg: 'beta' });
    expect(h.visible()).toContain('manual_provider_key');
    await h.callback({ cmd: 'model.create-model' }, { formValue: {
      manual_provider_key: 'beta', custom_model_names: 'ManualOne,Vendor/ManualTwo[1m]',
    } });
    await h.command('/model add-model beta ManualThree');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'FreshModel' }] }))));
    await h.command('/model refresh-provider beta');
    expect((await h.store.read()).keys.beta!.models).toEqual(expect.arrayContaining(['ManualOne', 'Vendor/ManualTwo[1m]', 'ManualThree', 'FreshModel']));
    expect(await h.store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
    expect(h.ctx.sessions.resumeFor('oc_test', '/workspace')).toBe('keep-session');
    expect(h.visible()).not.toContain('fixture-new-key');
    h.ctx.msg.senderId = 'ou_member';
    await h.command('/model add-model beta ForbiddenModel');
    expect(h.visible()).toContain('仅管理员');
    expect((await h.store.read()).keys.beta!.models).not.toContain('ForbiddenModel');
    h.ctx.msg.senderId = 'ou_admin'; h.ctx.chatMode = 'group';
    await h.callback({ cmd: 'model.create-model' }, { formValue: { manual_provider_key: 'beta', custom_model_names: 'GroupModel' } });
    expect((await h.store.read()).keys.beta!.models).not.toContain('GroupModel');
  });

  it('switches Claude through real card dispatch without touching Codex files or repeating credentials', async () => {
    const h = await harness('claude');
    const codexBefore = await readFile(join(h.codexDir, 'config.toml'), 'utf8');
    h.ctx.sessions.set('oc_test', 'old-session', '/workspace');
    await h.command('/model');
    expect(h.visible()).toContain('Claude 模型与服务商');
    await h.callback({ cmd: 'model.submit', arg: 'beta' }, { formValue: { model_name: 'Vendor/NewModel' } });
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    const root = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8')) as RootConfig;
    expect(root.profiles.claude!.preferences.model).toBeUndefined();
    expect(root.profiles.codex).toEqual(h.root.profiles.codex);
    expect(await readFile(join(h.codexDir, 'config.toml'), 'utf8')).toBe(codexBefore);
    expect(h.ctx.sessions.resumeFor('oc_test', '/workspace')).toBeUndefined();
    expect(h.visible()).not.toContain('fixture-new-key');
  });

  it('enforces administrator access and in-flight protection for Claude too', async () => {
    const h = await harness('claude'); h.ctx.msg.senderId = 'ou_member';
    await h.command('/model beta/Vendor/NewModel');
    expect(h.visible()).toContain('仅管理员');
    expect((await h.store.current())?.key).toBe('alpha');
    h.ctx.msg.senderId = 'ou_admin';
    const release = h.ctx.activeRuns.reserve('other-chat')!;
    await h.callback({ cmd: 'model.submit', arg: 'beta' }, { formValue: { model_name: 'Vendor/NewModel' } });
    expect(h.visible()).toContain('有任务运行中');
    expect((await h.store.current())?.key).toBe('alpha');
    release();
  });

  it('requires admin access for both text commands and card callbacks', async () => {
    const h = await harness(); h.ctx.msg.senderId = 'ou_member';
    const before = await readFile(join(h.codexDir, 'config.toml'), 'utf8');
    await h.command('/model beta/Vendor/NewModel');
    await h.callback({ cmd: 'model.submit', arg: 'beta' }, { formValue: { model_name: 'Vendor/NewModel' } });
    expect(h.visible()).toContain('仅管理员');
    expect(await readFile(join(h.codexDir, 'config.toml'), 'utf8')).toBe(before);
  });

  it('switches case-sensitive model names, clears only the active profile override, and starts a fresh chat session', async () => {
    const h = await harness(); h.ctx.sessions.set('oc_test', 'old-thread', '/workspace');
    h.ctx.sessions.setIdleTimeoutMinutes('oc_test', 15);
    await h.command('/model beta/Vendor/NewModel');
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    const root = JSON.parse(await readFile(join(h.dir, 'config.json'), 'utf8')) as RootConfig;
    expect(root.profiles.codex!.preferences.model).toBeUndefined();
    expect(root.profiles.claude).toEqual(h.root.profiles.claude);
    expect(h.ctx.sessions.resumeFor('oc_test', '/workspace')).toBeUndefined();
    expect(h.ctx.sessions.getIdleTimeoutMinutes('oc_test')).toBe(15);
    expect(h.visible()).toContain('已切换到 beta/Vendor/NewModel');
    expect(h.visible()).not.toContain('fixture-new-key');
  });

  it('shows actual config status and never prefills stored secrets in editing forms', async () => {
    const h = await harness();
    await h.command('/model status');
    await h.command('/model edit-provider beta');
    expect(h.visible()).toContain('alpha/OldModel');
    expect(h.visible()).toContain('Base URL');
    expect(h.visible()).toContain('留空保留原密钥');
    expect(h.visible()).not.toContain('fixture-new-key');
    expect(h.visible()).not.toContain('fixture-old-key');
  });

  it('switches provider and its last-used model in one step when the dropdown changes', async () => {
    const h = await harness(); h.ctx.sessions.set('oc_test', 'old-session', '/workspace');
    await h.callback({ cmd: 'model.load-provider' }, { option: 'beta' });
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    expect(h.ctx.sessions.resumeFor('oc_test', '/workspace')).toBeUndefined();
    expect(h.visible()).toContain('已切换到 beta/Vendor/NewModel');
    expect(h.visible()).toContain('尚无使用记录');
    expect(h.visible()).toContain('"initial_option":"beta"');
    expect(h.visible()).toContain('"initial_option":"Vendor/NewModel"');
    expect(h.channel.rawClient.requests.filter((r) => r.method === 'cardkit.v1.card.update')).toHaveLength(0);
    await h.callback({ cmd: 'model.load-provider' }, { option: 'alpha' });
    expect(await h.store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
    expect(h.visible()).toContain('已切换到 alpha/OldModel（该服务商上次使用的模型）');
    expect(h.visible()).not.toContain('fixture-new-key');
  });

  it('only redisplays the active provider without restarting the chat session', async () => {
    const h = await harness(); h.ctx.sessions.set('oc_test', 'old-session', '/workspace');
    await h.callback({ cmd: 'model.load-provider' }, { option: 'alpha' });
    expect(await h.store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
    expect(h.ctx.sessions.resumeFor('oc_test', '/workspace')).toBe('old-session');
    expect(h.visible()).toContain('"initial_option":"alpha"');
    expect(h.visible()).not.toContain('已切换到');
  });

  it('keeps the card on the chosen provider when the one-step switch is blocked or has no models', async () => {
    const h = await harness();
    const release = h.ctx.activeRuns.reserve('other-chat')!;
    await h.callback({ cmd: 'model.load-provider' }, { option: 'beta' });
    expect((await h.store.current())?.key).toBe('alpha');
    expect(h.visible()).toContain('有任务运行中');
    expect(h.visible()).toContain('"initial_option":"beta"');
    expect(h.ctx.activeRuns.newRunsPaused()).toBe(false);
    release();
    const registry = JSON.parse(await readFile(join(h.codexDir, 'model-registry.json'), 'utf8'));
    registry.keys.gamma = { baseUrl: 'https://gamma.test/v1', auth: { OPENAI_API_KEY: 'fixture-gamma-key' }, models: [] };
    await writeFile(join(h.codexDir, 'model-registry.json'), JSON.stringify(registry));
    await h.callback({ cmd: 'model.load-provider' }, { option: 'gamma' });
    expect((await h.store.current())?.key).toBe('alpha');
    expect(h.visible()).toContain('暂无缓存模型');
    expect(h.visible()).toContain('"initial_option":"gamma"');
  });

  it('merges SDK, raw and nested form values while keeping submitted keys out of all replies', async () => {
    const h = await harness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'CaseSensitive' }] }))));
    await h.callback({ cmd: 'model.create-provider' }, {
      formValue: { key_name: '', base_url: '' },
      raw: { action: { form_value: { key_name: 'gamma', base_url: 'https://gamma.test/v1' }, value: { form_value: { api_key: 'fixture-submitted-key' } } } },
    });
    expect((await h.store.read()).keys.gamma).toMatchObject({ auth: { OPENAI_API_KEY: 'fixture-submitted-key' }, models: ['CaseSensitive'] });
    expect(h.visible()).toContain('服务商已添加');
    expect(h.visible()).not.toContain('fixture-submitted-key');
  });

  it('keeps mutation disabled during active runs or preparations and always releases its pause', async () => {
    const h = await harness();
    const release = h.ctx.activeRuns.reserve('other-chat')!;
    await h.command('/model beta/Vendor/NewModel');
    expect((await h.store.current())?.key).toBe('alpha');
    expect(h.visible()).toContain('有任务运行中');
    expect(h.ctx.activeRuns.newRunsPaused()).toBe(false);
    release();
    const run = h.ctx.agent.run({ runId: 'fixture-run', prompt: 'fixture' });
    h.ctx.activeRuns.register('other-chat', run);
    await h.command('/model beta/Vendor/NewModel');
    expect((await h.store.current())?.key).toBe('alpha');
    h.ctx.activeRuns.unregister('other-chat', run);
  });

  it('requires a deletion confirmation and protects the active provider', async () => {
    const h = await harness();
    await h.command('/model delete-provider beta');
    expect(h.visible()).toContain('确认删除');
    expect((await h.store.read()).keys.beta).toBeDefined();
    await h.callback({ cmd: 'model.confirm-delete-provider', arg: 'beta' });
    expect((await h.store.read()).keys.beta).toBeUndefined();
    await h.command('/model delete-provider alpha');
    expect((await h.store.read()).keys.alpha).toBeDefined();
    expect(h.visible()).toContain('先切换到其他服务商');
  });

  it.each(['codex', 'claude'] as const)('selects a specific inactive %s provider before deletion', async (agentKind) => {
    const h = await harness(agentKind);
    await h.command('/model');
    const modelCard = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(modelCard).toContain('"cmd":"model.delete-provider"');
    expect(modelCard).not.toContain('"cmd":"model.delete-provider","arg":"alpha"');

    await h.callback({ cmd: 'model.delete-provider' });
    const selectCard = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(selectCard).toContain('"name":"delete_provider_key"');
    expect(selectCard).toContain('"value":"beta"');
    expect(selectCard).not.toContain('"value":"alpha"');
    expect(selectCard).not.toContain('"initial_option"');
    expect((await h.store.read()).keys.beta).toBeDefined();

    await h.callback({ cmd: 'model.select-delete-provider' }, { formValue: { delete_provider_key: 'beta' } });
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('"cmd":"model.confirm-delete-provider","arg":"beta"');
    expect((await h.store.read()).keys.beta).toBeDefined();
    await h.callback({ cmd: 'model.confirm-delete-provider', arg: 'beta' });
    expect((await h.store.read()).keys.beta).toBeUndefined();
    expect(await h.store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
  });

  it('rejects missing, active, and stale deletion selections without deleting any provider', async () => {
    const h = await harness();
    await h.callback({ cmd: 'model.select-delete-provider' });
    expect(h.visible()).toContain('请选择要删除的服务商');
    await h.callback({ cmd: 'model.select-delete-provider' }, { formValue: { delete_provider_key: 'alpha' } });
    expect(h.visible()).toContain('先切换到其他服务商');
    await h.callback({ cmd: 'model.select-delete-provider' }, { formValue: { delete_provider_key: 'beta' } });
    await h.command('/model beta/Vendor/NewModel');
    await h.callback({ cmd: 'model.confirm-delete-provider', arg: 'beta' });
    expect(h.visible()).toContain('先切换到其他服务商');
    expect(Object.keys((await h.store.read()).keys)).toEqual(['alpha', 'beta']);
  });

  it.each(['codex', 'claude'] as const)('can delete the former %s provider after switching without switching back to select it', async (agentKind) => {
    const h = await harness(agentKind);
    await h.callback({ cmd: 'model.load-provider' }, { option: 'beta' });
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });

    await h.callback({ cmd: 'model.delete-provider' });
    const selectCard = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(selectCard).toContain('"value":"alpha"');
    expect(selectCard).not.toContain('"value":"beta"');

    await h.callback({ cmd: 'model.select-delete-provider' }, { formValue: { delete_provider_key: 'alpha' } });
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    expect((await h.store.read()).keys.alpha).toBeDefined();
    await h.callback({ cmd: 'model.confirm-delete-provider', arg: 'alpha' });
    expect((await h.store.read()).keys.alpha).toBeUndefined();
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
  });

  it('handles form submit without a model_key field using the provider bound to the button', async () => {
    const h = await harness();
    await h.callback({ cmd: 'model.submit', arg: 'beta' }, { formValue: { model_name: 'Vendor/NewModel' } });
    expect(await h.store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
  });

  it('replaces the cached list with the provider response when refresh succeeds', async () => {
    const h = await harness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'AddedModel' }] }))));
    await h.command('/model refresh-provider beta');
    expect((await h.store.read()).keys.beta!.models).toEqual(['AddedModel']);
    expect(h.visible()).toContain('移除 1 个');
  });

  it('does not expose provider response bodies or overwrite cached models on refresh errors', async () => {
    const h = await harness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture-secret-from-provider', { status: 401 })));
    await h.command('/model refresh-provider beta');
    expect(h.visible()).toContain('HTTP 401');
    expect(h.visible()).not.toContain('fixture-secret-from-provider');
    expect((await h.store.read()).keys.beta!.models).toEqual(['Vendor/NewModel']);
  });

  it('asks for credential editing in private chat without accepting a group form', async () => {
    const h = await harness(); h.ctx.chatMode = 'group';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await h.callback({ cmd: 'model.create-provider' }, { formValue: { key_name: 'gamma', base_url: 'https://gamma.test', api_key: 'fixture-key' } });
    expect(h.visible()).toContain('私聊中编辑');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps an explicitly ignored Codex config unchanged', async () => {
    const h = await harness(); h.ctx.controls.profileConfig.codex!.ignoreUserConfig = true;
    await runCommandHandler('model', 'beta/Vendor/NewModel', h.ctx);
    expect((await h.store.current())?.key).toBe('alpha');
    expect(h.visible()).toContain('忽略用户配置');
  });
});
