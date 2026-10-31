import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCodeBuddyModels, getCodeBuddyCatalog, parseCodeBuddyModels } from '../../src/agent/codebuddy/models';
import { codeBuddyModelCard } from '../../src/card/codebuddy-model-card';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeAcp(mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'cb-model-test-'));
  directories.push(directory);
  const binary = join(directory, 'codebuddy');
  const record = join(directory, 'calls.jsonl');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({input:process.stdin});
lines.on('line', line => {
 const request=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(request)+String.fromCharCode(10));
 if (${JSON.stringify(mode)} === 'timeout') return;
 if (request.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion:1}}));
 else if (request.method === 'session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:request.id, result:{models:{currentModelId:'auto',availableModels:[{modelId:'auto',name:'Auto',_meta:{credits:''}},{modelId:'new-model',name:'Model',_meta:{credits:'x0.00'}}]}}}));
});
`, { mode: 0o700 });
  return { directory, binary, record };
}

describe('WorkBuddy model discovery', () => {
  it('reads official ACP metadata without sending a model prompt', async () => {
    const fake = await fakeAcp();
    const catalog = await discoverCodeBuddyModels(fake.binary);
    expect(catalog.models).toEqual([{ id: 'auto', name: 'Auto', credits: '' }, { id: 'new-model', name: 'Model', credits: 'x0.00' }]);
    const calls = (await readFile(fake.record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'session/new']);
    expect(calls[1].params.mcpServers).toEqual([]);
  });

  it('times out a stalled CLI', async () => {
    const fake = await fakeAcp('timeout');
    await expect(discoverCodeBuddyModels(fake.binary, 100)).rejects.toThrow('超时');
  });

  it('reuses the cache and marks it stale if a forced refresh fails', async () => {
    const fake = await fakeAcp();
    vi.stubEnv('LARK_CHANNEL_CODEBUDDY_BIN', fake.binary);
    const first = await getCodeBuddyCatalog(fake.directory);
    const second = await getCodeBuddyCatalog(fake.directory);
    expect(second.catalog).toEqual(first.catalog);
    expect((await readFile(fake.record, 'utf8')).trim().split('\n')).toHaveLength(2);
    vi.stubEnv('LARK_CHANNEL_CODEBUDDY_BIN', join(fake.directory, 'missing'));
    const fallback = await getCodeBuddyCatalog(fake.directory, true);
    expect(fallback.stale).toBe(true);
    expect(fallback.catalog).toEqual(first.catalog);
  });

  it('distinguishes missing rates from an explicit zero and rejects unusable catalogs', () => {
    const catalog = parseCodeBuddyModels({ availableModels: [
      { modelId: 'auto', name: 'Auto', _meta: { credits: '' } },
      { modelId: 'zero', name: 'Zero', _meta: { credits: 'x0.00' } },
      { modelId: 'zero', name: 'Duplicate' },
      { modelId: '--unsafe' },
    ] });
    expect(catalog.models).toHaveLength(2);
    const card = JSON.parse(JSON.stringify(codeBuddyModelCard(catalog, 'auto', false)));
    const dropdown = card.body.elements.find((element: { tag: string }) => element.tag === 'form').elements[0];
    expect(dropdown.options).toEqual([
      { text: { tag: 'plain_text', content: '跟随 WorkBuddy 默认模型' }, value: 'default' },
      { text: { tag: 'plain_text', content: 'Auto [auto] · 倍率未提供' }, value: 'auto' },
      { text: { tag: 'plain_text', content: 'Zero [zero] · x0.00' }, value: 'zero' },
    ]);
    expect(dropdown.initial_option).toBe('auto');
    const bodyText = card.body.elements.filter((element: { tag: string }) => element.tag === 'markdown').map((element: { content: string }) => element.content).join('\n');
    expect(bodyText).toContain('空值不代表免费');
    expect(bodyText).not.toContain('官方可选模型');
    expect(bodyText).not.toContain('Zero');
    expect(bodyText).not.toContain('x0.00');
    expect(() => parseCodeBuddyModels({ availableModels: [] })).toThrow('没有可用模型');
  });
});
