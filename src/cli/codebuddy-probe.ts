import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeBuddyAdapter } from '../agent/codebuddy/adapter';
import { discoverCodeBuddyModels, getCodeBuddyCatalog } from '../agent/codebuddy/models';

if (process.argv.includes('--models')) {
  const cacheOption = process.argv.indexOf('--cache-dir');
  const cacheDirectory = cacheOption >= 0 ? process.argv[cacheOption + 1] : undefined;
  if (cacheOption >= 0 && (!cacheDirectory || cacheDirectory.startsWith('--'))) throw new Error('--cache-dir requires a directory');
  const catalog = cacheDirectory ? (await getCodeBuddyCatalog(cacheDirectory, true)).catalog : await discoverCodeBuddyModels();
  console.log(JSON.stringify(catalog, null, 2));
} else {
const directory = await mkdtemp(join(tmpdir(), 'codebuddy-bridge-probe-'));
try {
  const adapter = new CodeBuddyAdapter();
  const available = await adapter.checkAvailability();
  if (!available.ok) throw available.error;
  console.log(`CodeBuddy CLI version: ${available.version}`);
  let sessionId: string | undefined;
  for (const [round, prompt] of [
    '只回复 BRIDGE_PROBE_OK，不读取文件、不运行命令、不调用任何工具。',
    '上一条消息要求你回复的英文标识是什么？只重复该标识，不读取文件、不运行命令、不调用任何工具。',
  ].entries()) {
    const run = adapter.run({
      runId: `codebuddy-probe-${round + 1}`, prompt, cwd: directory,
      sessionId, permissionMode: 'plan', stopGraceMs: 1000,
    });
    const timer = setTimeout(() => { void run.stop(); }, 30_000);
    let answer = '';
    let succeeded = false;
    try {
      for await (const event of run.events) {
        if (event.type === 'system' && event.sessionId) sessionId = event.sessionId;
        if (event.type === 'text') answer += event.delta;
        if (event.type === 'error') { console.error(event.message); break; }
        if (event.type === 'done') {
          sessionId = event.sessionId ?? sessionId;
          succeeded = answer.trim() === 'BRIDGE_PROBE_OK' && Boolean(sessionId);
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      if (!(await run.waitForExit(1000))) await run.stop();
    }
    console.log(succeeded ? `PASS: real CodeBuddy round ${round + 1}` : `NOT READY: CodeBuddy round ${round + 1} failed`);
    if (!succeeded) {
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
}
