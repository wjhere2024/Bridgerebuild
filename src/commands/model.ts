import { sendManagedCard } from '../card/managed';
import { modelAddKeyFormCard, modelAddModelsFormCard, modelDeleteConfirmCard, modelDeleteProviderSelectCard, modelEditKeyFormCard, modelSelectionCard } from '../card/model-card';
import { clearModelPreference, profileAppPaths } from '../config/config-ops';
import { join } from 'node:path';
import { ModelError } from '../model/discovery';
import { ClaudeModelStore } from '../model/claude-registry';
import { CodexModelStore, modelsFromText, normalizeProviderName } from '../model/registry';
import type { CommandContext } from './index';

const USAGE = [
  '**模型管理**',
  '`/model` — 选择服务商和模型',
  '`/model status` — 查看当前默认模型',
  '`/model 服务商/模型名` — 切换默认模型（保留模型名大小写）',
  '`/model 服务商` — 切换到该服务商上次使用的模型（没有记录时用首个模型）',
  '`/model refresh-provider 服务商` — 按服务商当前列表更新缓存，移除已不存在的自动发现模型，保留手动模型；失败时保留原列表',
  '`/model add-model 服务商 模型名` — 手动添加模型（逗号分隔多个，刷新后保留）',
  '`/model add-provider` / `/model edit-provider 服务商` — 在私聊中管理认证',
  '`/model delete-provider` — 选择服务商并确认删除（不能删除当前使用的服务商）',
].join('\n');

function replyOptions(ctx: CommandContext) {
  return { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}) };
}

async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { markdown }, replyOptions(ctx));
}

async function showCard(ctx: CommandContext, card: object): Promise<void> {
  // A fresh card avoids stale CardKit sequence numbers after form submission.
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, replyOptions(ctx));
}

async function showModels(ctx: CommandContext, store: CodexModelStore, opts: { selectedKey?: string; selectedModel?: string; notice?: string; error?: string } = {}): Promise<void> {
  const registry = await store.read();
  const current = await store.current();
  await showCard(ctx, modelSelectionCard({
    ...opts,
    agentName: ctx.controls.profileConfig.agentKind === 'claude' ? 'Claude' : 'Codex',
    currentProfile: current ? `${current.key}/${current.model}` : '',
    providerKeys: Object.keys(registry.keys),
    profiles: Object.entries(registry.keys).flatMap(([key, entry]) => entry.models.map((model) => ({
      key, model, name: `${key}/${model}`, current: current?.key === key && current.model === model,
    }))),
    overrideModel: ctx.controls.profileConfig.preferences.model,
  }));
}

function formText(ctx: CommandContext, name: string): string {
  return typeof ctx.formValue?.[name] === 'string' ? (ctx.formValue[name] as string).trim() : '';
}

function requirePrivateChat(ctx: CommandContext): void {
  if (ctx.chatMode !== 'p2p') throw new ModelError('请在与机器人的私聊中编辑服务商认证。');
}

async function changeRuntime<T>(ctx: CommandContext, operation: () => Promise<T>): Promise<T> {
  const release = ctx.activeRuns.pauseNewRuns('正在切换模型配置');
  try {
    if (ctx.activeRuns.hasInFlight()) throw new ModelError('当前有任务运行中，请等待任务结束后再修改模型配置。');
    return await operation();
  } finally { release(); }
}

const SESSION_HINT = '当前聊天的下一条消息将开启新会话；其他已有会话可发送 /new 使用新配置。';

/** Switch the agent's default model and start the current chat on a fresh session. */
async function applySelection(ctx: CommandContext, store: CodexModelStore, selection: { key: string; model: string }): Promise<void> {
  await changeRuntime(ctx, () => store.select(selection.key, selection.model, () => clearModelPreference(ctx.controls)));
  ctx.sessions.clear(ctx.scope);
  await ctx.sessions.flush();
}

/** Picking a provider switches to it in one step, restoring the model it was last used with. */
async function switchProvider(ctx: CommandContext, store: CodexModelStore, selectedKey: string): Promise<void> {
  const registry = await store.read();
  const entry = Object.hasOwn(registry.keys, selectedKey) ? registry.keys[selectedKey] : undefined;
  if (!entry) throw new ModelError('指定的服务商不存在。');
  if ((await store.current())?.key === selectedKey) { await showModels(ctx, store, { selectedKey }); return; }
  const selection = await store.resolve(selectedKey);
  if (!selection) { await showModels(ctx, store, { selectedKey, error: '该服务商暂无缓存模型，请先刷新模型列表再切换。' }); return; }
  try {
    await applySelection(ctx, store, selection);
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    await showModels(ctx, store, { selectedKey, selectedModel: selection.model, error: `${error.message} 仍在使用原配置。` });
    return;
  }
  const origin = entry.lastModel === selection.model ? '该服务商上次使用的模型' : '该服务商尚无使用记录，已选用首个模型';
  await showModels(ctx, store, { selectedKey, notice: `已切换到 ${selection.key}/${selection.model}（${origin}）。如需其他模型，请在下方选择后点击「切换模型」。${SESSION_HINT}` });
}

export async function handleModel(args: string, ctx: CommandContext): Promise<void> {
  try {
    const isClaude = ctx.controls.profileConfig.agentKind === 'claude';
    const agentName = isClaude ? 'Claude' : 'Codex';
    const config = ctx.controls.profileConfig.codex;
    if (!isClaude && config?.ignoreUserConfig) throw new ModelError('当前 Codex 忽略用户配置，无法通过 /model 切换服务商。');
    const store = isClaude ? new ClaudeModelStore() : new CodexModelStore(config?.codexHome || (config?.inheritCodexHome === false
      ? join(profileAppPaths(ctx.controls).profileDir, 'codex-home') : undefined));
    const raw = args.trim();
    const [first = '', ...rest] = raw.split(/\s+/);
    const action = first.toLowerCase();
    const target = rest.join(' ');
    if (!raw || ['cancel', 'cancel-key'].includes(action)) { await showModels(ctx, store); return; }
    if (['-', 'help', '--help'].includes(action)) { await reply(ctx, USAGE); return; }
    if (action === 'status') {
      const current = await store.current();
      const registry = await store.read();
      await reply(ctx, `${agentName} 默认模型：${current ? `${current.key}/${current.model}` : '尚未选择'}\n服务商：${Object.keys(registry.keys).length} 个` +
        (ctx.controls.profileConfig.preferences.model ? `\n/config 模型覆盖：${ctx.controls.profileConfig.preferences.model}` : ''));
      return;
    }
    if (['load-provider', 'load-key'].includes(action)) {
      await switchProvider(ctx, store, normalizeProviderName(target || formText(ctx, 'model_key'))); return;
    }
    if (action === 'refresh-provider') {
      const selectedKey = normalizeProviderName(target || formText(ctx, 'model_key'));
      const result = await store.refresh(selectedKey);
      const current = await store.current();
      const models = (await store.read()).keys[selectedKey]?.models ?? [];
      const staleCurrent = current?.key === selectedKey && !models.includes(current.model);
      await showModels(ctx, store, { selectedKey, notice: `模型列表已刷新：缓存 ${result.count} 个，新增 ${result.added} 个，移除 ${result.removed} 个。` +
        (staleCurrent ? `当前默认模型 ${current.model} 已不在服务商列表中，请改选后切换。` : '') }); return;
    }
    if (['add-provider', 'add-key'].includes(action)) {
      requirePrivateChat(ctx); await showCard(ctx, modelAddKeyFormCard(agentName)); return;
    }
    if (['delete-provider', 'delete-key'].includes(action) && !target) {
      const registry = await store.read();
      const active = await store.current();
      await showCard(ctx, modelDeleteProviderSelectCard(Object.keys(registry.keys).filter((key) =>
        key !== active?.key && key !== registry.current?.key), agentName));
      return;
    }
    if (['edit-provider', 'edit-key', 'delete-provider', 'delete-key', 'select-delete-provider'].includes(action)) {
      const requestedKey = action === 'select-delete-provider' ? formText(ctx, 'delete_provider_key') : target || formText(ctx, 'model_key');
      if (!requestedKey && action === 'select-delete-provider') throw new ModelError('请选择要删除的服务商。');
      const key = normalizeProviderName(requestedKey);
      const registry = await store.read();
      if (!Object.hasOwn(registry.keys, key)) throw new ModelError('指定的服务商不存在。');
      const entry = registry.keys[key]!;
      if (action.startsWith('edit-')) {
        requirePrivateChat(ctx);
        await showCard(ctx, modelEditKeyFormCard({ key, baseUrl: entry.baseUrl, models: entry.models, refreshedAt: entry.modelsRefreshedAt }, agentName));
      } else {
        if ((await store.current())?.key === key) throw new ModelError('当前正在使用该服务商，请先切换到其他服务商。');
        await showCard(ctx, modelDeleteConfirmCard({ key }));
      }
      return;
    }
    if (['confirm-delete-provider', 'confirm-delete-key'].includes(action)) {
      await store.deleteProvider(normalizeProviderName(target));
      await showModels(ctx, store, { notice: '服务商及其缓存模型已删除。' }); return;
    }
    if (['create-provider', 'create-key', 'update-provider', 'update-key'].includes(action)) {
      requirePrivateChat(ctx);
      const editing = action.startsWith('update-');
      const save = () => store.saveProvider({
        key: editing ? target || formText(ctx, 'key_name') : formText(ctx, 'key_name'),
        baseUrl: formText(ctx, 'base_url') || formText(ctx, 'base_url_choice'),
        apiKey: formText(ctx, 'api_key'),
        fallbackModels: modelsFromText(formText(ctx, 'custom_model_names')),
      }, editing);
      const result = editing ? await changeRuntime(ctx, save) : await save();
      await showModels(ctx, store, { selectedKey: result.key, notice: result.warning ?? `服务商已${editing ? '更新' : '添加'}，缓存 ${result.count} 个模型。` }); return;
    }
    if (['add-model', 'create-model'].includes(action)) {
      if (ctx.chatMode !== 'p2p') throw new ModelError('请在与机器人的私聊中添加模型。');
      const [requestedKey = '', ...names] = rest;
      const key = requestedKey || formText(ctx, 'manual_provider_key');
      const models = modelsFromText(names.join(' ') || formText(ctx, 'custom_model_names'));
      if (action === 'add-model' && !models.length) {
        const registry = await store.read();
        const selectedKey = key ? normalizeProviderName(key) : undefined;
        if (selectedKey && !Object.hasOwn(registry.keys, selectedKey)) throw new ModelError('指定的服务商不存在。');
        await showCard(ctx, modelAddModelsFormCard(Object.keys(registry.keys), selectedKey, agentName));
        return;
      }
      const selectedKey = normalizeProviderName(key);
      const result = await store.addModels(selectedKey, models);
      await showModels(ctx, store, { selectedKey, notice: `手动模型已保存，新增 ${result.added} 个，缓存共 ${result.count} 个。刷新后保留；当前模型未切换，调用可用性需另行验证。` });
      return;
    }
    if (['edit-model', 'update-model', 'delete-model', 'confirm-delete-model'].includes(action)) {
      throw new ModelError('可使用「添加模型」保存新的模型名称；暂不支持在卡片中改名或删除单个模型。');
    }
    const requested = action === 'submit'
      ? `${target || formText(ctx, 'model_key')}/${formText(ctx, 'model_name')}`
      : action === 'use' ? target : raw;
    const selection = await store.resolve(requested);
    if (!selection) throw new ModelError('没有找到所选服务商和模型，请刷新卡片后重新选择。');
    await applySelection(ctx, store, selection);
    await showModels(ctx, store, { selectedKey: selection.key, notice: `已切换到 ${selection.key}/${selection.model}。${SESSION_HINT}` });
  } catch (error) {
    // Never echo parser errors, network response bodies, or submitted form data.
    const message = error instanceof ModelError ? error.message : '操作失败，请检查本机配置文件权限和 Bridge 运行状态。';
    await reply(ctx, `❌ ${message}`).catch(() => {});
  }
}
