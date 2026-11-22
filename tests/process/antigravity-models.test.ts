import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverAntigravityModels, getAntigravityCatalog, parseAntigravityModels } from '../../src/agent/antigravity/models';
import { antigravityModelCard } from '../../src/card/antigravity-model-card';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const REAL_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  '',
].join('\n');

async function fakeAgy(mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'agy-model-test-'));
  directories.push(directory);
  const binary = join(directory, 'agy');
  const script = mode === 'timeout'
    ? '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n'
    : mode === 'fail'
      ? '#!/usr/bin/env node\nconsole.error("not logged in");\nprocess.exit(1);\n'
      : `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(REAL_OUTPUT)});\n`;
  await writeFile(binary, script, { mode: 0o700 });
  return { directory, binary };
}

describe('Antigravity model discovery', () => {
  it('parses real `agy models` output, skipping the progress line', () => {
    const catalog = parseAntigravityModels(REAL_OUTPUT);
    expect(catalog.models).toEqual([
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('rejects empty model lists', () => {
    expect(() => parseAntigravityModels('Fetching available models...\n')).toThrow('没有可用模型');
  });

  it('discovers models by running the CLI', async () => {
    const fake = await fakeAgy();
    const catalog = await discoverAntigravityModels(fake.binary);
    expect(catalog.models.map((model) => model.id)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'claude-sonnet-4-6',
    ]);
  });

  it('times out a stalled CLI', async () => {
    const fake = await fakeAgy('timeout');
    await expect(discoverAntigravityModels(fake.binary, 100)).rejects.toThrow('超时');
  });

  it('surfaces CLI failures', async () => {
    const fake = await fakeAgy('fail');
    await expect(discoverAntigravityModels(fake.binary)).rejects.toThrow('not logged in');
  });

  it('reuses the cache and marks it stale if a forced refresh fails', async () => {
    const fake = await fakeAgy();
    const first = await getAntigravityCatalog(fake.directory, fake.binary);
    expect(first.stale).toBe(false);
    expect(first.catalog.models).toHaveLength(3);
    const cached = await getAntigravityCatalog(fake.directory, fake.binary);
    expect(cached.stale).toBe(false);
    const failing = await fakeAgy('fail');
    const stale = await getAntigravityCatalog(fake.directory, failing.binary, true);
    expect(stale.stale).toBe(true);
    expect(stale.catalog.models).toHaveLength(3);
  });

  it('renders a model card with a default option and the discovered models', () => {
    const catalog = parseAntigravityModels(REAL_OUTPUT);
    const card = antigravityModelCard(catalog, 'default', false) as { body: { elements: Array<Record<string, unknown>> } };
    const form = card.body.elements.find((element) => element.tag === 'form') as { elements: Array<Record<string, unknown>> };
    const select = form.elements.find((element) => element.tag === 'select_static') as { options: Array<{ value: string }> };
    expect(select.options.map((option) => option.value)).toEqual([
      'default',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'claude-sonnet-4-6',
    ]);
  });
});
