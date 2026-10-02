import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexModelStore, type ModelRegistry } from '../../../src/model/registry';

let dir: string;
let store: CodexModelStore;
const config = `model_provider = "alpha"\nmodel = "OldModel"\nmodel_reasoning_effort = "high"\n[model_providers.alpha]\nname = "alpha"\nbase_url = "https://alpha.test/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n[projects."/workspace"]\ntrust_level = "trusted"\n[mcp_servers.fixture]\ncommand = "fixture-command"\n`;
function fixture(): ModelRegistry {
  return { version: 1, current: { key: 'alpha', model: 'OldModel' }, keys: {
    alpha: { baseUrl: 'https://alpha.test/v1', auth: { OPENAI_API_KEY: 'fixture-old-key' }, models: ['OldModel'] },
    beta: { baseUrl: 'https://beta.test/v1', auth: { OPENAI_API_KEY: 'fixture-new-key' }, models: ['Vendor/NewModel'] },
  } };
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridge-model-store-'));
  store = new CodexModelStore(dir);
  await writeFile(join(dir, 'config.toml'), config);
  await writeFile(join(dir, 'auth.json'), '{"OPENAI_API_KEY":"fixture-old-key"}\n');
  await writeFile(join(dir, 'model-registry.json'), JSON.stringify(fixture()));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe('restored Codex registry', () => {
  it('adds the any-provider 1M marker only to Claude models', async () => {
    const registry = fixture();
    registry.keys.any = {
      baseUrl: 'https://any.test/v1', auth: { OPENAI_API_KEY: 'fixture-any' },
      models: ['gpt-5.5', 'gpt-5.5[1M]', 'claude-opus-5-5', 'claude-opus-5-5[1M]'],
      lastModel: 'gpt-5.5[1M]',
    };
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    expect((await store.read()).keys.any).toMatchObject({
      models: ['gpt-5.5', 'claude-opus-5-5[1M]'], lastModel: 'gpt-5.5',
    });
    await store.select('any', 'gpt-5.5');
    expect(await store.current()).toEqual({ key: 'any', model: 'gpt-5.5' });
    await store.select('any', 'claude-opus-5-5');
    expect(await store.current()).toEqual({ key: 'any', model: 'claude-opus-5-5[1M]' });
  });

  it('switches model and auth together while retaining project trust, MCP, and reasoning settings', async () => {
    await store.select('beta', 'Vendor/NewModel');
    const selected = parse(await readFile(join(dir, 'config.toml'), 'utf8'));
    expect(selected).toMatchObject({
      model_provider: 'beta', model: 'Vendor/NewModel', model_reasoning_effort: 'high',
      projects: { '/workspace': { trust_level: 'trusted' } }, mcp_servers: { fixture: { command: 'fixture-command' } },
    });
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))).toEqual({ OPENAI_API_KEY: 'fixture-new-key' });
    expect((await store.read()).current).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    // Windows reports read/write flags, not POSIX owner/group permission bits.
    if (process.platform !== 'win32') {
      for (const name of ['config.toml', 'auth.json', 'model-registry.json']) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    }
    const backups = await readdir(join(dir, 'model-backups'));
    expect(await readFile(join(dir, 'model-backups', backups[0]!, 'config.toml'), 'utf8')).toBe(config);
  });

  it('rolls all three files back if saving the Bridge profile fails', async () => {
    const names = ['config.toml', 'auth.json', 'model-registry.json'];
    const before = await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')));
    await expect(store.select('beta', 'Vendor/NewModel', async () => { throw new Error('fixture failure'); })).rejects.toThrow('已回滚');
    expect(await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))).toEqual(before);
  });

  it('uses an env key, removes stale global auth, and rejects missing env credentials', async () => {
    const registry = fixture();
    registry.keys.beta!.envKey = 'BRIDGE_TEST_PROVIDER_KEY';
    registry.keys.beta!.auth = {};
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    await expect(store.select('beta', 'Vendor/NewModel')).rejects.toThrow('缺少可用认证');
    vi.stubEnv('BRIDGE_TEST_PROVIDER_KEY', 'fixture-env-key');
    await store.select('beta', 'Vendor/NewModel');
    expect(parse(await readFile(join(dir, 'config.toml'), 'utf8'))).toMatchObject({ model_providers: { beta: { env_key: 'BRIDGE_TEST_PROVIDER_KEY' } } });
    await expect(stat(join(dir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps cached models on refresh failures and drops models the provider no longer lists', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('fixture-secret', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'AddedModel' }] })));
    vi.stubGlobal('fetch', fetcher);
    const registry = fixture();
    registry.keys.beta!.lastModel = 'Vendor/NewModel';
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    const before = await readFile(join(dir, 'model-registry.json'), 'utf8');
    await expect(store.refresh('beta')).rejects.toThrow('503');
    expect(await readFile(join(dir, 'model-registry.json'), 'utf8')).toBe(before);
    expect(await store.refresh('beta')).toEqual({ count: 1, added: 1, removed: 1 });
    const beta = (await store.read()).keys.beta!;
    expect(beta.models).toEqual(['AddedModel']);
    expect(beta.lastModel).toBeUndefined();
    expect((await store.read()).current).toEqual({ key: 'alpha', model: 'OldModel' });
  });

  it('rejects duplicate providers before making network requests', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(store.saveProvider({ key: 'beta', baseUrl: 'https://new.test', apiKey: 'new' }, false)).rejects.toThrow('已存在');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves a blank edit key and updates active config even if model discovery is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const result = await store.saveProvider({ key: 'alpha', baseUrl: 'https://replacement.test/v1', apiKey: '' }, true);
    expect(result.warning).toContain('保留缓存');
    const registry = await store.read();
    expect(registry.keys.alpha).toMatchObject({ baseUrl: 'https://replacement.test/v1', auth: { OPENAI_API_KEY: 'fixture-old-key' }, models: ['OldModel'] });
    expect(parse(await readFile(join(dir, 'config.toml'), 'utf8'))).toMatchObject({ model_providers: { alpha: { base_url: 'https://replacement.test/v1' } } });
  });

  it('replaces env auth with the explicitly edited key', async () => {
    const registry = fixture(); registry.keys.beta!.envKey = 'BRIDGE_TEST_OLD_PROVIDER_KEY';
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'New' }] }))));
    await store.saveProvider({ key: 'beta', baseUrl: 'https://beta.test/v1', apiKey: 'fixture-replacement' }, true);
    expect((await store.read()).keys.beta!.envKey).toBeUndefined();
    await store.select('beta', 'New');
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).OPENAI_API_KEY).toBe('fixture-replacement');
  });

  it('requires known fallback names instead of inventing models when adding an unavailable provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const input = { key: 'gamma', baseUrl: 'https://gamma.test/v1', apiKey: 'fixture-key' };
    await expect(store.saveProvider(input, false)).rejects.toThrow('填写已知的模型名称');
    expect((await store.read()).keys.gamma).toBeUndefined();
    expect(await store.saveProvider({ ...input, fallbackModels: ['KnownModel'] }, false)).toMatchObject({ key: 'gamma', count: 1 });
    expect((await store.read()).current?.key).toBe('alpha');
  });

  it('keeps manual additions through successful discovery and does not switch or rewrite credentials', async () => {
    const before = await readFile(join(dir, 'config.toml'), 'utf8');
    const auth = await readFile(join(dir, 'auth.json'), 'utf8');
    await store.addModels('beta', ['ManualModel', 'ManualModel']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'FreshModel' }] }))));
    expect(await store.refresh('beta')).toMatchObject({ count: 2, removed: 1 });
    expect((await store.read()).keys.beta).toMatchObject({ models: ['FreshModel', 'ManualModel'], manualModels: ['ManualModel'] });
    await store.saveProvider({ key: 'beta', baseUrl: 'https://beta.test/v1', apiKey: '', fallbackModels: ['OtherManual'] }, true);
    await store.refresh('beta');
    expect((await store.read()).keys.beta!.models).toEqual(['FreshModel', 'ManualModel', 'OtherManual']);
    expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(before);
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(auth);
    await expect(store.addModels('beta', ['invalid model'])).rejects.toThrow('名称');
    await expect(store.addModels('beta', [])).rejects.toThrow('至少一个');
    await expect(store.addModels('missing', ['KnownModel'])).rejects.toThrow('不存在');
  });

  it('serializes manual additions and rejects malformed manual metadata', async () => {
    await Promise.all(['One', 'Two'].map((name) => new CodexModelStore(dir).addModels('beta', [name])));
    expect((await store.read()).keys.beta!.manualModels).toEqual(['One', 'Two']);
    const reg = fixture();
    (reg.keys.beta as unknown as { manualModels: unknown }).manualModels = 'invalid';
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(reg));
    await expect(store.read()).rejects.toThrow('注册表格式不正确');
  });

  it('protects the active provider and does not trust a stale registry pointer', async () => {
    const registry = fixture(); registry.current = { key: 'beta', model: 'Vendor/NewModel' };
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    await expect(store.deleteProvider('alpha')).rejects.toThrow('当前正在使用');
    await expect(store.deleteProvider('beta')).rejects.toThrow('当前正在使用');
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(fixture()));
    await store.deleteProvider('BETA');
    expect((await store.read()).keys.beta).toBeUndefined();
  });

  it('serializes concurrent provider additions without losing either entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'Model' }] }))));
    await Promise.all(['gamma', 'delta'].map((key) => new CodexModelStore(dir).saveProvider({ key, baseUrl: `https://${key}.test/v1`, apiKey: 'fixture' }, false)));
    expect(Object.keys((await store.read()).keys)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma', 'delta']));
  });

  it('restores the model each provider was last switched to instead of its first cached model', async () => {
    const registry = fixture();
    registry.keys.alpha!.models = ['OldModel', 'AlphaSecond'];
    registry.keys.beta!.models = ['Vendor/NewModel', 'Vendor/Other'];
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    await store.select('alpha', 'AlphaSecond');
    await store.select('beta', 'Vendor/Other');
    expect((await store.read()).keys).toMatchObject({ alpha: { lastModel: 'AlphaSecond' }, beta: { lastModel: 'Vendor/Other' } });
    expect(await store.resolve('alpha')).toEqual({ key: 'alpha', model: 'AlphaSecond' });
    expect(await store.resolve('beta')).toEqual({ key: 'beta', model: 'Vendor/Other' });
    await store.select('alpha', 'OldModel');
    expect(await store.resolve('beta')).toEqual({ key: 'beta', model: 'Vendor/Other' });
    expect(await store.resolve('alpha')).toEqual({ key: 'alpha', model: 'OldModel' });
  });

  it('remembers the model a provider was left on even when it was selected outside the Bridge', async () => {
    const registry = fixture();
    delete registry.current;
    registry.keys.alpha!.models = ['Zeta', 'OldModel'];
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    await store.select('beta', 'Vendor/NewModel');
    expect((await store.read()).keys.alpha!.lastModel).toBe('OldModel');
    expect(await store.resolve('alpha')).toEqual({ key: 'alpha', model: 'OldModel' });
  });

  it('falls back to the first cached model when the remembered one is gone and rejects malformed memory', async () => {
    const registry = fixture();
    registry.keys.beta!.models = ['Vendor/NewModel', 'Vendor/Other'];
    registry.keys.beta!.lastModel = 'Vendor/Removed';
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry));
    expect(await store.resolve('beta')).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify({ ...registry, keys: { ...registry.keys, beta: { ...registry.keys.beta, lastModel: 5 } } }));
    await expect(store.read()).rejects.toThrow('注册表格式不正确');
  });

  it('rejects corrupt registries without leaking their contents or silently recreating them', async () => {
    const corrupt = '{"secret":"fixture-private-key",invalid';
    await writeFile(join(dir, 'model-registry.json'), corrupt);
    await expect(store.read()).rejects.toThrow('注册表格式不正确');
    expect(await readFile(join(dir, 'model-registry.json'), 'utf8')).toBe(corrupt);
  });
});
