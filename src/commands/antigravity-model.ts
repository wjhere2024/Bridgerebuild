import { getAntigravityCatalog } from '../agent/antigravity/models';
import { antigravityModelCard } from '../card/antigravity-model-card';
import { sendManagedCard } from '../card/managed';
import { profileAppPaths, setModelPreference } from '../config/config-ops';
import type { CommandContext } from './index';

export async function handleAntigravityModel(args: string, ctx: CommandContext): Promise<void> {
  const options = { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}) };
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, options);
  const raw = args.trim();
  if (['help', '--help', '-'].includes(raw)) {
    await reply('`/model` 列出当前账号可用模型；`/model 模型ID` 切换；`/model refresh` 刷新（换账号后用）；`/model status` 查看当前选择；`/model default` 跟随账号默认。');
    return;
  }
  try {
    const binary = ctx.controls.profileConfig.antigravity?.binaryPath;
    if (!binary) throw new Error('当前 profile 未配置 Antigravity CLI 路径，无法查询模型列表。');
    const selection = raw === 'submit' ? String(ctx.formValue?.model_name ?? '').trim() : raw;
    const switching = !['', 'list', 'status', 'refresh', 'cancel', 'credits'].includes(selection);
    if (switching && ctx.activeRuns.hasInFlight()) throw new Error('当前有任务运行中，请等待完成或 /stop 后再切换模型。');
    const { catalog, stale } = await getAntigravityCatalog(profileAppPaths(ctx.controls).profileDir, binary, selection === 'refresh');
    let notice: string | undefined;
    if (raw === 'submit' && !selection) throw new Error('请选择一个模型。');
    if (switching) {
      if (selection !== 'default' && !catalog.models.some((model) => model.id === selection)) throw new Error('该模型不在当前账号的可选列表中，请使用 /model 查看或 /model refresh 刷新。');
      if (stale && selection !== 'default') throw new Error('当前无法核实最新模型列表，暂不切换。请稍后 /model refresh 再试。');
      const release = ctx.activeRuns.pauseNewRuns('正在切换 Antigravity 模型');
      try {
        if (ctx.activeRuns.hasInFlight()) throw new Error('当前有任务运行中，请稍后再切换。');
        await setModelPreference(ctx.controls, selection);
        if (ctx.sessionCatalogIdentity) ctx.sessionCatalog?.archiveActive(ctx.sessionCatalogIdentity);
        ctx.sessions.clear(ctx.scope);
        await Promise.all([ctx.sessions.flush(), ctx.sessionCatalog?.flush()]);
      } finally { release(); }
      notice = `已切换为 ${selection === 'default' ? '跟随 Antigravity 默认模型' : selection}。当前聊天下一条消息开启新会话；其他聊天可用 /new 开启新会话。`;
    }
    await sendManagedCard(ctx.channel, ctx.msg.chatId, antigravityModelCard(catalog, ctx.controls.profileConfig.preferences.model || 'default', stale, notice), options);
  } catch (error) {
    await reply(`❌ ${error instanceof Error ? error.message : 'Antigravity 模型操作失败，请稍后重试。'}`);
  }
}
