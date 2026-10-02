import { getServiceAdapter } from '../daemon/service-adapter';
import { resolveTarget } from '../runtime/registry';
import type { CommandContext } from './index';

/** The recovered /restart replaces the process; /reconnect only reloads its connection. */
export async function handleRestart(args: string, ctx: CommandContext): Promise<void> {
  const reply = (markdown: string) => ctx.channel.send(ctx.msg.chatId, { markdown }, {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  });
  const target = args.trim();
  const entry = target ? resolveTarget(target) : undefined;
  if (target && !entry) {
    await reply('没有找到指定的 bot。请发送 /ps 查看，再使用 /restart 或 /restart <id|#>。');
    return;
  }
  const self = !entry || entry.id === ctx.controls.processId;
  const profile = self ? ctx.controls.profile : entry.profileName;
  const adapter = getServiceAdapter(profile);
  // A merely installed unit might belong to another process. Do not exit a
  // foreground process and falsely promise that the service will relaunch it.
  const ownedPid = adapter?.fileExists() && adapter.isRunning()
    ? Number(adapter.parseStatus(adapter.describeStatus()).pid) : undefined;
  if (!adapter || ownedPid !== (self ? process.pid : entry.pid)) {
    await reply('该 bot 当前不由独立的系统服务托管，请在服务器终端重启对应进程。');
    return;
  }
  await reply(`正在重启 ${profile}，系统服务会重新加载代码和配置。请在恢复连接后继续发送消息。`);
  if (self) {
    await ctx.activeRuns.stopAll();
    await ctx.controls.exit();
  } else {
    const result = await adapter.restart();
    await reply(result.ok ? '系统服务已重启。' : '重启失败，请查看该服务的本机日志。');
  }
}
