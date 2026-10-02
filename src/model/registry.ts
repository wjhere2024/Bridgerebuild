import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { withConfigFileLock } from '../config/profile-store';
import { writeFileAtomic } from '../platform/atomic-write';
import { discoverProviderModels, ModelError, normalizeBaseUrl, normalizeModelName } from './discovery';

export interface RegistryProvider {
  baseUrl: string;
  baseUrls?: string[];
  auth: Record<string, string>;
  envKey?: string;
  models: string[];
  /** Explicit local additions survive provider discovery refreshes. */
  manualModels?: string[];
  modelsRefreshedAt?: string;
  /** Model this provider was last switched to; restored when the provider is selected again. */
  lastModel?: string;
}

export interface ModelRegistry {
  version: 1;
  current?: { key: string; model: string };
  keys: Record<string, RegistryProvider>;
}

export interface ProviderInput {
  key: string;
  baseUrl: string;
  apiKey: string;
  fallbackModels?: string[];
}

export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function normalizeProviderName(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
    throw new ModelError('服务商名称只能包含小写字母、数字、下划线和连字符，最长 64 位。');
  }
  return key;
}

export function modelsFromText(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[\n,，]+/).map((v) => v.trim()).filter(Boolean).map(normalizeModelName))];
}

export function normalizeProviderModelName(provider: string, value: string): string {
  const model = normalizeModelName(value);
  if (provider.toLowerCase() !== 'any') return model;

  // Default policy for the Codex registry: only Claude IDs get the marker.
  // ClaudeModelStore overrides this for AnyRouter Messages compatibility IDs.
  // Remove stale auto-added markers from other model names.
  const baseModel = model.replace(/\[1m\]$/i, '');
  return /(?:^|[\/:_-])claude(?:$|[\/:_-])/i.test(baseModel) ? `${baseModel}[1M]` : baseModel;
}

export async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseConfig(text = ''): TomlTable {
  try { return parse(text); } catch { throw new ModelError('Codex 配置格式不正确，未覆盖原配置。'); }
}

/** Preserve unrelated TOML tables (including project trust and MCP settings). */
export function selectedConfig(text: string, key: string, model: string, entry: RegistryProvider): string {
  const config = parseConfig(text);
  config.model_provider = key;
  config.model = model;
  const providers = (config.model_providers ?? {}) as TomlTable;
  const previous = (providers[key] ?? {}) as TomlTable;
  // Authentication comes from the selected registry entry, never a stale header.
  const { env_key: _env, requires_openai_auth: _auth, http_headers: _headers,
    env_http_headers: _envHeaders, experimental_bearer_token: _token, ...options } = previous;
  providers[key] = {
    ...options,
    name: key,
    base_url: normalizeBaseUrl(entry.baseUrl),
    wire_api: 'responses',
    ...(entry.envKey ? { env_key: entry.envKey } : { requires_openai_auth: true }),
  };
  config.model_providers = providers;
  return stringify(config);
}

/** Compatible with the version-1 registry recovered from the September backup. */
export class CodexModelStore {
  constructor(readonly dir: string = codexHomeDir()) {}

  protected path(name: string): string { return join(this.dir, name); }

  protected normalizeModel(key: string, model: string): string { return normalizeProviderModelName(key, model); }

  async read(): Promise<ModelRegistry> {
    const text = await optionalFile(this.path('model-registry.json'));
    if (text === undefined) return { version: 1, keys: {} };
    try {
      const raw = JSON.parse(text) as ModelRegistry;
      if (raw.version !== 1 || !raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) throw new Error();
      for (const [key, entry] of Object.entries(raw.keys)) {
        if (normalizeProviderName(key) !== key || !entry || typeof entry !== 'object') throw new Error();
        normalizeBaseUrl(entry.baseUrl);
        if (!Array.isArray(entry.models) || !entry.models.every((m) => typeof m === 'string' && normalizeModelName(m) === m)) throw new Error();
        if (!entry.auth || typeof entry.auth !== 'object' || Array.isArray(entry.auth) ||
          !Object.values(entry.auth).every((value) => typeof value === 'string')) throw new Error();
        if (entry.envKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.envKey)) throw new Error();
        if (entry.lastModel !== undefined && (typeof entry.lastModel !== 'string' || normalizeModelName(entry.lastModel) !== entry.lastModel)) throw new Error();
        if (entry.manualModels !== undefined && (!Array.isArray(entry.manualModels) ||
          !entry.manualModels.every((m) => typeof m === 'string' && normalizeModelName(m) === m))) throw new Error();
        if (entry.manualModels) entry.manualModels = [...new Set(entry.manualModels.map((model) => this.normalizeModel(key, model)))];
        entry.models = [...new Set([...entry.models, ...(entry.manualModels ?? [])].map((model) => this.normalizeModel(key, model)))];
        if (entry.lastModel) entry.lastModel = this.normalizeModel(key, entry.lastModel);
      }
      if (raw.current && (typeof raw.current.key !== 'string' || typeof raw.current.model !== 'string')) throw new Error();
      if (raw.current) raw.current.model = this.normalizeModel(raw.current.key, raw.current.model);
      return raw;
    } catch {
      throw new ModelError('模型注册表格式不正确，未覆盖原文件。');
    }
  }

  async current(): Promise<ModelRegistry['current']> {
    const config = parseConfig(await optionalFile(this.path('config.toml')));
    return typeof config.model_provider === 'string' && typeof config.model === 'string'
      ? { key: config.model_provider, model: config.model } : undefined;
  }

  protected key(entry: RegistryProvider): string | undefined {
    // env_key is authoritative until an explicit key edit changes auth mode.
    return entry.envKey ? process.env[entry.envKey] : entry.auth.OPENAI_API_KEY;
  }

  protected provider(registry: ModelRegistry, key: string): RegistryProvider {
    if (!Object.hasOwn(registry.keys, key)) throw new ModelError('指定的服务商不存在。');
    return registry.keys[key]!;
  }

  /** The model a provider comes back with: its active model, else the one it was last switched to, else its first cached model. */
  protected preferredModel(key: string, entry: RegistryProvider, current: ModelRegistry['current']): string | undefined {
    if (current?.key === key && entry.models.includes(current.model)) return current.model;
    if (entry.lastModel && entry.models.includes(entry.lastModel)) return entry.lastModel;
    return entry.models[0];
  }

  /** Record where each provider was left so switching back restores that model; unknown models are never stored. */
  protected remember(registry: ModelRegistry, ...selections: Array<ModelRegistry['current']>): void {
    for (const selection of selections) {
      const entry = selection && Object.hasOwn(registry.keys, selection.key) ? registry.keys[selection.key] : undefined;
      if (entry?.models.includes(selection!.model)) entry.lastModel = selection!.model;
    }
  }

  protected async selectionFiles(key: string, model: string, entry: RegistryProvider): Promise<Map<string, string | undefined>> {
    return new Map([
      ['config.toml', selectedConfig(await optionalFile(this.path('config.toml')) ?? '', key, model, entry)],
      ['auth.json', entry.envKey ? undefined : `${JSON.stringify(entry.auth, null, 2)}\n`],
    ]);
  }

  protected discover(entry: RegistryProvider): Promise<{ models: string[] }> {
    return discoverProviderModels({ baseUrl: entry.baseUrl, apiKey: this.key(entry), kind: 'openai' });
  }

  protected newAuth(apiKey: string, _existing?: RegistryProvider): Record<string, string> {
    return { OPENAI_API_KEY: apiKey };
  }

  /** Serialize across bot processes and save private rollback material first. */
  protected async commit(registry: ModelRegistry, selection?: { key: string; model: string }, afterSave?: () => Promise<void>): Promise<void> {
    const writes = new Map<string, string | undefined>();
    if (selection) {
      const entry = this.provider(registry, selection.key);
      if (!entry.models.includes(selection.model)) throw new ModelError('该服务商没有所选模型，请刷新模型列表。');
      if (!this.key(entry)) throw new ModelError('该服务商缺少可用认证，未切换模型。');
      for (const [name, value] of await this.selectionFiles(selection.key, selection.model, entry)) writes.set(name, value);
      this.remember(registry, await this.current(), selection);
      registry.current = selection;
    }
    writes.set('model-registry.json', `${JSON.stringify(registry, null, 2)}\n`);
    await this.writeTransaction(writes, afterSave);
  }

  protected async writeTransaction(writes: Map<string, string | undefined>, afterSave?: () => Promise<void>): Promise<void> {
    const before = new Map<string, string | undefined>();
    const backup = this.path(join('model-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of writes.keys()) {
      const contents = await optionalFile(this.path(name));
      before.set(name, contents);
      if (contents !== undefined) await writeFileAtomic(join(backup, name), contents, { mode: 0o600 });
    }
    await writeFileAtomic(join(backup, 'manifest.json'), JSON.stringify(Object.fromEntries([...before].map(([name, value]) => [name, value !== undefined])), null, 2));
    try {
      for (const [name, value] of writes) {
        if (value === undefined) await rm(this.path(name), { force: true });
        else await writeFileAtomic(this.path(name), value, { mode: 0o600 });
      }
      await afterSave?.();
    } catch {
      let restored = true;
      for (const [name, value] of before) {
        try {
          if (value === undefined) await rm(this.path(name), { force: true });
          else await writeFileAtomic(this.path(name), value, { mode: 0o600 });
        } catch { restored = false; }
      }
      throw new ModelError(restored ? '保存失败，已回滚本次模型配置更改。' : '保存失败；回滚未全部完成，请从模型配置目录下的 model-backups 恢复。');
    }
  }

  protected mutate<T>(fn: () => Promise<T>): Promise<T> {
    return withConfigFileLock(this.path('model-registry.json'), fn);
  }

  async resolve(value: string): Promise<{ key: string; model: string } | undefined> {
    const registry = await this.read();
    const separator = value.indexOf('/') > 0 ? value.indexOf('/') : value.indexOf(':');
    if (separator > 0) {
      const key = normalizeProviderName(value.slice(0, separator));
      const model = value.slice(separator + 1); // Model IDs are case-sensitive.
      return Object.hasOwn(registry.keys, key) && registry.keys[key]?.models.includes(model) ? { key, model } : undefined;
    }
    const key = normalizeProviderName(value);
    const entry = Object.hasOwn(registry.keys, key) ? registry.keys[key] : undefined;
    if (entry) {
      const model = this.preferredModel(key, entry, await this.current());
      return model ? { key, model } : undefined;
    }
    return this.resolveLegacy(key, registry);
  }

  protected async resolveLegacy(key: string, registry: ModelRegistry): Promise<ModelRegistry['current']> {
    // Keep backed-up codex-use aliases available without invoking a shell.
    const legacy = await optionalFile(this.path(`${key}.config.toml`));
    if (!legacy) return undefined;
    const config = parseConfig(legacy);
    if (typeof config.model !== 'string' || typeof config.model_provider !== 'string') return undefined;
    const provider = config.model_provider;
    return Object.hasOwn(registry.keys, provider) && registry.keys[provider]?.models.includes(config.model)
      ? { key: provider, model: config.model } : undefined;
  }

  async select(key: string, model: string, afterSave?: () => Promise<void>): Promise<void> {
    await this.mutate(async () => {
      key = normalizeProviderName(key);
      await this.commit(await this.read(), { key, model: this.normalizeModel(key, model) }, afterSave);
    });
  }

  async addModels(key: string, models: string[]): Promise<{ count: number; added: number }> {
    return this.mutate(async () => {
      key = normalizeProviderName(key);
      const names = [...new Set(models.map((model) => this.normalizeModel(key, model)))];
      if (!names.length) throw new ModelError('请填写至少一个模型名称。');
      const registry = await this.read();
      const entry = this.provider(registry, key);
      const previous = new Set(entry.models);
      entry.manualModels = [...new Set([...(entry.manualModels ?? []), ...names])].sort((a, b) => a.localeCompare(b));
      entry.models = [...new Set([...entry.models, ...names])].sort((a, b) => a.localeCompare(b));
      await this.commit(registry);
      return { count: entry.models.length, added: entry.models.filter((model) => !previous.has(model)).length };
    });
  }

  async refresh(key: string): Promise<{ count: number; added: number; removed: number }> {
    return this.mutate(async () => {
      const registry = await this.read();
      key = normalizeProviderName(key);
      const entry = this.provider(registry, key);
      const result = await this.discover(entry);
      const previous = new Set(entry.models);
      const discovered = [...new Set(result.models.map((model) => this.normalizeModel(key, model)))].sort((a, b) => a.localeCompare(b));
      const available = new Set([...discovered, ...(entry.manualModels ?? [])]);
      entry.models = [...available].sort((a, b) => a.localeCompare(b));
      entry.modelsRefreshedAt = new Date().toISOString();
      if (entry.lastModel && !available.has(entry.lastModel)) delete entry.lastModel;
      await this.commit(registry);
      return {
        count: entry.models.length,
        added: entry.models.filter((model) => !previous.has(model)).length,
        removed: [...previous].filter((model) => !available.has(model)).length,
      };
    });
  }

  async saveProvider(input: ProviderInput, editing: boolean): Promise<{ key: string; count: number; warning?: string }> {
    return this.mutate(async () => {
      const registry = await this.read();
      const key = normalizeProviderName(input.key);
      const existing = Object.hasOwn(registry.keys, key) ? registry.keys[key] : undefined;
      if (editing && !existing) throw new ModelError('指定的服务商不存在。');
      if (!editing && existing) throw new ModelError('服务商已存在，未覆盖现有配置；请使用「编辑服务商」。');
      const apiKey = input.apiKey.trim();
      if (/[^\x20-\x7e]/.test(apiKey) || (!apiKey && !editing)) throw new ModelError('API Key 不能为空或包含控制字符。');
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const entry: RegistryProvider = {
        ...existing,
        baseUrl,
        baseUrls: [baseUrl],
        auth: apiKey ? this.newAuth(apiKey, existing) : { ...existing?.auth },
        models: [...(existing?.models ?? [])],
      };
      if (apiKey) delete entry.envKey;
      const fallback = (input.fallbackModels ?? []).map((model) => this.normalizeModel(key, model));
      if (fallback.length) entry.manualModels = [...new Set([...(entry.manualModels ?? []), ...fallback])];
      let warning: string | undefined;
      try {
        const result = await this.discover(entry);
        entry.models = [...new Set([...entry.models, ...result.models.map((model) => this.normalizeModel(key, model))])];
        entry.modelsRefreshedAt = new Date().toISOString();
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        if (!entry.models.length && !fallback.length) throw new ModelError(`${error.message} 请检查认证或填写已知的模型名称后再保存。`);
        entry.models = [...new Set([...entry.models, ...fallback])];
        warning = `${error.message} 已保存服务商配置并保留缓存及手动填写的模型；这些模型尚未重新验证。`;
      }
      entry.models = [...new Set([...entry.models, ...(entry.manualModels ?? [])])].sort((a, b) => a.localeCompare(b));
      registry.keys[key] = entry;
      const active = await this.current();
      await this.commit(registry, editing && active?.key === key ? active : undefined);
      return { key, count: entry.models.length, ...(warning ? { warning } : {}) };
    });
  }

  async deleteProvider(key: string): Promise<void> {
    await this.mutate(async () => {
      key = normalizeProviderName(key);
      const registry = await this.read();
      this.provider(registry, key);
      if (registry.current?.key === key || (await this.current())?.key === key) throw new ModelError('当前正在使用该服务商，请先切换到其他服务商。');
      delete registry.keys[key];
      await this.commit(registry);
    });
  }
}
