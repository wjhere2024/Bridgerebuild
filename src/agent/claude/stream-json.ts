import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  // `system` / `api_retry` fields — the CLI's provider retry loop.
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    if (evt.is_error || evt.subtype?.startsWith('error_')) {
      const detail = typeof evt.result === 'string' ? evt.result.trim() : '';
      yield {
        type: 'error',
        message: detail
          ? `Claude 调用失败：${truncate(detail, 500)}`
          : 'Claude 调用失败，请检查当前服务商状态、模型名称和认证。',
        terminationReason: 'failed',
      };
    } else {
      yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
    }
  }
}

/**
 * How long the Claude CLI may keep retrying a failing provider request
 * (non-terminal `system` / `api_retry` events) with no other progress before
 * the bridge gives up. The CLI retries on its own for a few minutes; this is
 * the safety net for versions or outages where it retries much longer.
 * Mirrors CODEX_RECONNECT_GIVE_UP_MS.
 */
export const CLAUDE_API_RETRY_GIVE_UP_MS = 5 * 60_000;

export interface ClaudeStreamJsonTranslatorOptions {
  apiRetryGiveUpMs?: number;
  now?: () => number;
}

/**
 * Stateful translator for `claude -p --output-format stream-json` lines.
 *
 * The CLI reports provider trouble (connection failures, HTTP 401/5xx, …) as
 * non-terminal `system` / `api_retry` events while it retries. `translate`
 * turns them into `notice` events the UI can display, and gives up with a
 * terminal error when retries keep failing without any other progress.
 */
export class ClaudeStreamJsonTranslator {
  private terminal = false;
  private retrySince: number | undefined;
  private readonly apiRetryGiveUpMs: number;
  private readonly now: () => number;

  constructor(options: ClaudeStreamJsonTranslatorOptions = {}) {
    this.apiRetryGiveUpMs = options.apiRetryGiveUpMs ?? CLAUDE_API_RETRY_GIVE_UP_MS;
    this.now = options.now ?? Date.now;
  }

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!raw || typeof raw !== 'object') return [];
    const evt = raw as ClaudeRawEvent;

    if (evt.type === 'system' && evt.subtype === 'api_retry') {
      return this.translateApiRetry(evt);
    }
    // Any other protocol event means Claude got through to the provider.
    this.retrySince = undefined;

    const events = [...translateEvent(raw)];
    if (events.some((event) => event.type === 'done' || event.type === 'error')) {
      this.terminal = true;
    }
    return events;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateApiRetry(evt: ClaudeRawEvent): AgentEvent[] {
    const detail = retryDetail(evt);
    log.warn('stream-json', 'api_retry', { detail });

    const now = this.now();
    if (this.retrySince === undefined) this.retrySince = now;
    const stalledMs = now - this.retrySince;
    if (stalledMs >= this.apiRetryGiveUpMs) {
      this.terminal = true;
      const minutes = Math.max(1, Math.round(stalledMs / 60_000));
      log.warn('stream-json', 'api_retry_give_up', { stalledMs, detail });
      return [
        {
          type: 'error',
          message: truncate(
            `模型服务商连接失败，已持续重连约 ${minutes} 分钟仍未恢复，本次任务已终止。` +
              `请检查网络、Hosts 映射或中转站状态后重试。最后错误：${detail}`,
            4096,
          ),
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'notice', message: truncate(detail, 500) }];
  }
}

/** One-line detail for an `api_retry` event, e.g. `HTTP 401 authentication_failed，第 3/10 次重试`. */
function retryDetail(evt: ClaudeRawEvent): string {
  const parts: string[] = [];
  if (typeof evt.error_status === 'number') parts.push(`HTTP ${evt.error_status}`);
  if (typeof evt.error === 'string' && evt.error && evt.error !== 'unknown') parts.push(evt.error);
  if (parts.length === 0) parts.push('连接失败');
  let detail = parts.join(' ');
  if (typeof evt.attempt === 'number' && typeof evt.max_retries === 'number') {
    detail += `，第 ${evt.attempt}/${evt.max_retries} 次重试`;
  }
  return detail;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
