import type { RunState } from './run-state';

/** Footer text while the agent is reconnecting to its model provider. */
export function reconnectingText(state: RunState): string {
  const detail = state.notice ? `（${state.notice}）` : '';
  return `🔌 模型服务商连接失败，正在重连…${detail}`;
}

export const RECONNECTING_SUMMARY = '网络重连中';
