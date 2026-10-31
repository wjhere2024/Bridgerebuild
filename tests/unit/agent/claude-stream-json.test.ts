import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { ClaudeStreamJsonTranslator, translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('translates assistant text, thinking, and tool_use blocks in order', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('reports failed Claude API calls as errors carrying the provider detail', () => {
    const events = [...translateEvent({ type: 'result', subtype: 'error_during_execution', is_error: true,
      api_error_status: 500, result: 'API Error: 500 Internal Server Error', session_id: 'fixture-session' })];
    expect(events).toEqual([{ type: 'error', message: 'Claude 调用失败：API Error: 500 Internal Server Error', terminationReason: 'failed' }]);
  });

  it('keeps the generic hint when a failed result carries no detail', () => {
    const events = [...translateEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'fixture-session' })];
    expect(events).toEqual([{ type: 'error', message: 'Claude 调用失败，请检查当前服务商状态、模型名称和认证。', terminationReason: 'failed' }]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 34, cachedInputTokens: 5, costUsd: 0.1234 },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
      },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('Claude provider retry handling', () => {
  it('translates api_retry events into reconnecting notices', () => {
    const t = new ClaudeStreamJsonTranslator();
    expect(
      t.translate({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 2225, error_status: 401, error: 'authentication_failed' }),
    ).toEqual([{ type: 'notice', message: 'HTTP 401 authentication_failed，第 3/10 次重试' }]);
    expect(t.terminalEmitted()).toBe(false);
  });

  it('falls back to a generic connection message for unknown retry errors', () => {
    const t = new ClaudeStreamJsonTranslator();
    expect(
      t.translate({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: null, error: 'unknown' }),
    ).toEqual([{ type: 'notice', message: '连接失败，第 1/10 次重试' }]);
  });

  it('gives up with a provider error when retries continue without progress', () => {
    let clock = 0;
    const t = new ClaudeStreamJsonTranslator({ apiRetryGiveUpMs: 5 * 60_000, now: () => clock });
    const retry = { type: 'system', subtype: 'api_retry', attempt: 8, max_retries: 10, error_status: 503, error: 'server_error' };

    expect(t.translate(retry)).toEqual([{ type: 'notice', message: 'HTTP 503 server_error，第 8/10 次重试' }]);
    clock = 2 * 60_000;
    expect(t.translate(retry)).toHaveLength(1);
    expect(t.terminalEmitted()).toBe(false);

    clock = 5 * 60_000;
    const events = t.translate(retry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toContain('模型服务商连接失败');
    expect((events[0] as { message: string }).message).toContain('5 分钟');
    expect((events[0] as { message: string }).message).toContain('HTTP 503 server_error');
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate(retry)).toEqual([]);
  });

  it('restarts the retry stall clock whenever Claude makes progress', () => {
    let clock = 0;
    const t = new ClaudeStreamJsonTranslator({ apiRetryGiveUpMs: 5 * 60_000, now: () => clock });
    const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: null, error: 'unknown' };

    expect(t.translate(retry)).toHaveLength(1);
    clock = 4 * 60_000;
    expect(t.translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'back' }] } })).toEqual([
      { type: 'text', delta: 'back' },
    ]);
    clock = 8 * 60_000;
    expect(t.translate(retry)).toEqual([{ type: 'notice', message: '连接失败，第 1/10 次重试' }]);
    expect(t.terminalEmitted()).toBe(false);
  });
});
