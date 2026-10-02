import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeModelStore } from '../../../src/model/claude-registry';
import type { ModelRegistry } from '../../../src/model/registry';

let dir: string;
let store: ClaudeModelStore;
const settings = { model: 'sonnet', env: {
  ANTHROPIC_AUTH_TOKEN: 'fixture-old', ANTHROPIC_API_KEY: 'fixture-stale', ANTHROPIC_BASE_URL: 'https://alpha.test',
  ANTHROPIC_MODEL: 'OldModel', ANTHROPIC_DEFAULT_SONNET_MODEL: 'RetiredAlias',
  ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-old-header',
  ANTHROPIC_BETAS: 'context-1m-2025-08-07,other-beta', KEEP_OPTION: 'keep',
}, enabledPlugins: { fixture: true }, effortLevel: 'high', permissions: { allow: ['Read'] } };
function registry(): ModelRegistry {
  return { version: 1, current: { key: 'beta', model: 'StalePointer' }, keys: {
    alpha: { baseUrl: 'https://alpha.test', auth: { ANTHROPIC_AUTH_TOKEN: 'fixture-old' }, models: ['OldModel'] },
    beta: { baseUrl: 'https://beta.test', auth: { ANTHROPIC_AUTH_TOKEN: 'fixture-new' }, models: ['Vendor/NewModel', 'Vendor/NewModel[1M]'] },
    any: { baseUrl: 'https://any.test', auth: { ANTHROPIC_AUTH_TOKEN: 'fixture-any' }, models: ['gpt-5.5', 'claude-opus-5-5[1M]'] },
  } };
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-model-test-')); store = new ClaudeModelStore(dir);
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(dir, 'model-registry.json'), JSON.stringify(registry()));
  await writeFile(join(dir, '.settings-profile'), 'old-profile\n');
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe('restored Claude settings and provider registry', () => {
  it('reports the effective env model instead of the settings alias or stale registry pointer', async () => {
    expect(await store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
    await expect(store.deleteProvider('alpha')).rejects.toThrow('正在使用');
  });

  it('switches model, authentication and profile atomically while preserving unrelated settings', async () => {
    await store.select('beta', 'Vendor/NewModel');
    const active = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(active).toMatchObject({ model: 'Vendor/NewModel', enabledPlugins: settings.enabledPlugins,
      permissions: settings.permissions, effortLevel: 'high', env: { ANTHROPIC_MODEL: 'Vendor/NewModel',
        ANTHROPIC_AUTH_TOKEN: 'fixture-new', ANTHROPIC_BASE_URL: 'https://beta.test', KEEP_OPTION: 'keep',
        ANTHROPIC_BETAS: 'other-beta', ANTHROPIC_DEFAULT_SONNET_MODEL: 'Vendor/NewModel' } });
    expect(active.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(active.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(await store.current()).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    const name = (await readFile(join(dir, '.settings-profile'), 'utf8')).trim();
    expect(JSON.parse(await readFile(join(dir, 'settings-profiles', `${name}.json`), 'utf8'))).toEqual(active);
    // Windows reports read/write flags, not POSIX owner/group permission bits.
    if (process.platform !== 'win32') {
      for (const file of ['settings.json', 'model-registry.json', '.settings-profile']) expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(join(dir, 'model-backups'))).toHaveLength(1);
  });

  it('adds the 1M beta only for a selected 1M model and removes it when leaving', async () => {
    await store.select('beta', 'Vendor/NewModel[1M]');
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
    await store.select('beta', 'Vendor/NewModel');
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).env.ANTHROPIC_BETAS).toBe('other-beta');
  });

  it('normalizes only Claude models for the any provider', async () => {
    await store.select('any', 'gpt-5.5[1M]');
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).env.ANTHROPIC_MODEL).toBe('gpt-5.5');
    await store.select('any', 'claude-opus-5-5');
    const active = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(active.env.ANTHROPIC_MODEL).toBe('claude-opus-5-5[1M]');
    expect(active.env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
  });

  it('keeps AnyRouter CLI cc markers and migrates cc-format without dropping its required beta', async () => {
    const reg = registry();
    reg.keys.any!.models.push('gpt-6-astra-cc-format[1M]', 'gpt-6-astra-cc[1m]');
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(reg));
    expect((await store.read()).keys.any!.models).toEqual(expect.arrayContaining(['gpt-6-astra-cc-format', 'gpt-6-astra-cc[1m]']));
    await store.select('any', 'gpt-6-astra-cc-format');
    let active = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(active.model).toBe('gpt-6-astra-cc-format');
    expect(active.env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
    await store.select('any', 'gpt-6-astra-cc[1m]');
    const profile = (await readFile(join(dir, '.settings-profile'), 'utf8')).trim();
    await store.select('alpha', 'OldModel');
    await store.useSettingsProfile(profile);
    active = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(active.model).toBe('gpt-6-astra-cc[1m]');
    expect(active.env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
    expect(await store.current()).toEqual({ key: 'any', model: 'gpt-6-astra-cc[1m]' });
    await store.select('any', 'gpt-6-astra-cc-format');
    const bareProfile = (await readFile(join(dir, '.settings-profile'), 'utf8')).trim();
    await store.select('alpha', 'OldModel');
    await store.useSettingsProfile(bareProfile);
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
  });

  it('rolls back settings, pointer, registry and newly created profile when the Bridge save fails', async () => {
    const files = ['settings.json', '.settings-profile', 'model-registry.json'];
    const before = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
    await expect(store.select('beta', 'Vendor/NewModel', async () => { throw new Error('fixture-secret'); })).rejects.toThrow('已回滚');
    expect(await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))).toEqual(before);
    expect(await readdir(join(dir, 'settings-profiles'))).toEqual([]);
  });

  it('refreshes Anthropic providers with Bearer auth and drops models the provider no longer lists', async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'NewListing' }] })));
    vi.stubGlobal('fetch', fetcher);
    await store.refresh('beta');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer fixture-new', 'anthropic-version': '2023-06-01' } });
    expect((await store.read()).keys.beta!.models).toEqual(['NewListing']);
  });

  it('preserves API-key auth mode when editing and removes a stale Bearer token on selection', async () => {
    const reg = registry(); reg.keys.beta!.auth = { ANTHROPIC_API_KEY: 'fixture-api' };
    await writeFile(join(dir, 'model-registry.json'), JSON.stringify(reg));
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'FreshModel' }] })));
    vi.stubGlobal('fetch', fetcher);
    await store.saveProvider({ key: 'beta', baseUrl: 'https://beta.test', apiKey: 'fixture-replaced' }, true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-api-key': 'fixture-replaced' } });
    await store.select('beta', 'FreshModel');
    const active = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(active.env.ANTHROPIC_API_KEY).toBe('fixture-replaced');
    expect(active.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('restores a full named profile through the helper and synchronizes the registry pointer', async () => {
    await mkdir(join(dir, 'settings-profiles'));
    const next = { ...settings, env: { ANTHROPIC_BASE_URL: 'https://beta.test', ANTHROPIC_AUTH_TOKEN: 'fixture-new', ANTHROPIC_MODEL: 'Vendor/NewModel' } };
    await writeFile(join(dir, 'settings-profiles', 'run.json'), JSON.stringify(next));
    await store.useSettingsProfile('run');
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ ...next, model: 'Vendor/NewModel' });
    expect((await store.read()).current).toEqual({ key: 'beta', model: 'Vendor/NewModel' });
    expect((await store.read()).keys).toMatchObject({ alpha: { lastModel: 'OldModel' }, beta: { lastModel: 'Vendor/NewModel' } });
    expect(await readFile(join(dir, '.settings-profile'), 'utf8')).toBe('run\n');
    await expect(store.useSettingsProfile('../../private')).rejects.toThrow('名称');
  });

  it('comes back to the model a provider was last used with, including its 1M variant', async () => {
    await store.select('beta', 'Vendor/NewModel[1M]');
    await store.select('alpha', 'OldModel');
    expect(await store.current()).toEqual({ key: 'alpha', model: 'OldModel' });
    expect(await store.resolve('beta')).toEqual({ key: 'beta', model: 'Vendor/NewModel[1M]' });
    await store.select('beta', 'Vendor/NewModel[1M]');
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).env.ANTHROPIC_BETAS).toContain('context-1m-2025-08-07');
  });

  it('does not overwrite invalid settings or leak their contents', async () => {
    const invalid = '{"token":"fixture-secret",invalid';
    await writeFile(join(dir, 'settings.json'), invalid);
    await expect(store.select('beta', 'Vendor/NewModel')).rejects.toThrow('JSON 格式不正确');
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(invalid);
  });
});
