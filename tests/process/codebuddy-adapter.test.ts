import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBuddyAdapter } from '../../src/agent/codebuddy/adapter';
import { CodeBuddyStreamJsonTranslator } from '../../src/agent/codebuddy/stream-json';
import type { AgentEvent } from '../../src/agent/types';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeCli(body: string): Promise<{ directory: string; binary: string; record: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-codebuddy-test-'));
  directories.push(directory);
  const binary = join(directory, 'codebuddy');
  const record = join(directory, 'record.json');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, profile: process.env.LARK_CHANNEL_PROFILE, channel: process.env.LARK_CHANNEL }));
  ${body}
});
`, { mode: 0o700 });
  return { directory, binary, record };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('CodeBuddy adapter', () => {
  it('passes prompts through stdin and preserves resume, model, permissions and profile isolation', async () => {
    const fake = await fakeCli(`console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cb-session' }));
console.log(JSON.stringify({ type: 'result', result: 'hello', session_id: 'cb-session' }));`);
    const adapter = new CodeBuddyAdapter({ binary: fake.binary, larkChannel: { profile: 'workbuddy-test', rootDir: fake.directory } });
    const run = adapter.run({ runId: 'test', prompt: '<request>hello $HOME</request>', cwd: fake.directory, sessionId: 'previous', model: 'auto', permissionMode: 'plan' });
    const events = await collect(run.events);
    expect(adapter.id).toBe('codebuddy');
    expect(events).toContainEqual({ type: 'text', delta: 'hello' });
    expect(events).toContainEqual({ type: 'done', sessionId: 'cb-session', terminationReason: 'normal' });
    const record = JSON.parse(await readFile(fake.record, 'utf8'));
    expect(record.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--resume', 'previous', '--model', 'auto']);
    expect(record.input).toContain('lark-channel-bridge 运行约定');
    expect(record.input).toContain('<request>hello $HOME</request>');
    expect(record.profile).toBe('workbuddy-test');
    expect(record.channel).toBe('1');
    expect(await run.waitForExit(1000)).toBe(true);
  });

  it('reports the real authentication error even when the CLI exits zero', async () => {
    const fake = await fakeCli(`console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication required. Please use /login'] }));`);
    const events = await collect(new CodeBuddyAdapter({ binary: fake.binary }).run({ runId: 'auth', prompt: 'hello', cwd: fake.directory }).events);
    expect(events).toEqual([{ type: 'error', message: 'CodeBuddy 调用失败：Authentication required. Please use /login', terminationReason: 'failed' }]);
  });

  it('rejects an incomplete stream instead of treating exit zero as success', async () => {
    const fake = await fakeCli(`console.log('startup noise');`);
    const events = await collect(new CodeBuddyAdapter({ binary: fake.binary }).run({ runId: 'empty', prompt: 'hello', cwd: fake.directory }).events);
    expect(events).toEqual([expect.objectContaining({ type: 'error', terminationReason: 'failed' })]);
  });

  it('stops an active process and its stream within the grace period', async () => {
    const fake = await fakeCli(`console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'waiting' })); setInterval(() => {}, 1000);`);
    const run = new CodeBuddyAdapter({ binary: fake.binary }).run({ runId: 'stop', prompt: 'hello', cwd: fake.directory, stopGraceMs: 100 });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    await run.stop();
    expect(await run.waitForExit(1000)).toBe(true);
    while (!(await iterator.next()).done) {}
  });

  it('does not duplicate final text and translates tool results', () => {
    const translator = new CodeBuddyStreamJsonTranslator();
    expect(translator.translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'example' } }] } })).toEqual([
      { type: 'text', delta: 'answer' },
      { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'example' } },
    ]);
    expect(translator.translate({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'data' }] } })).toEqual([{ type: 'tool_result', id: 'tool', output: 'data', isError: false }]);
    expect(translator.translate({ type: 'result', result: 'answer', session_id: 'session' })).toEqual([{ type: 'done', sessionId: 'session', terminationReason: 'normal' }]);
    expect(translator.translate({ type: 'result', result: 'answer' })).toEqual([]);
  });
});
