import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverProviderModels, ModelError, normalizeBaseUrl, normalizeModelName } from './discovery';
import { CodexModelStore, optionalFile, type ModelRegistry, type RegistryProvider } from './registry';

type Settings = Record<string, unknown> & { env?: Record<string, string>; model?: string };
const CONTEXT_BETA = 'context-1m-2025-08-07';

function isAnyMessagesModel(key: string, model: string): boolean {
  return key.toLowerCase() === 'any' && /^gpt-.+-cc(?:-format)?(?:\[1m\])?$/i.test(model);
}

function needsContextBeta(key: string, model: string): boolean {
  return /\[1m\]$/i.test(model) || isAnyMessagesModel(key, model);
}

export function claudeHomeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function parseClaudeSettings(text: string): Settings {
  try {
    const value = JSON.parse(text) as Settings;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.model !== undefined && typeof value.model !== 'string') ||
      (value.env !== undefined && (!value.env || typeof value.env !== 'object' || Array.isArray(value.env) ||
        !Object.values(value.env).every((item) => typeof item === 'string')))) throw new Error();
    return value;
  } catch { throw new ModelError('Claude settings JSON 格式不正确，未覆盖原配置。'); }
}

function profileName(key: string, model: string): string {
  return `bridge-${key}-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'model'}`;
}

export class ClaudeModelStore extends CodexModelStore {
  constructor(dir = claudeHomeDir()) { super(dir); }

  protected override normalizeModel(key: string, value: string): string {
    const model = normalizeModelName(value);
    if (isAnyMessagesModel(key, model)) {
      // The provider catalogue uses -cc-format, while its Claude CLI example
      // uses -cc[1m]. Keep the explicit CLI marker; migrate the old auto suffix.
      return /-cc-format(?:\[1m\])?$/i.test(model) ? model.replace(/\[1m\]$/i, '') : model;
    }
    return super.normalizeModel(key, model);
  }

  protected override key(entry: RegistryProvider): string | undefined {
    return entry.envKey ? process.env[entry.envKey] : entry.auth.ANTHROPIC_AUTH_TOKEN || entry.auth.ANTHROPIC_API_KEY;
  }

  protected override newAuth(apiKey: string, existing?: RegistryProvider): Record<string, string> {
    return existing?.auth.ANTHROPIC_API_KEY && !existing.auth.ANTHROPIC_AUTH_TOKEN
      ? { ANTHROPIC_API_KEY: apiKey } : { ANTHROPIC_AUTH_TOKEN: apiKey };
  }

  protected override discover(entry: RegistryProvider): Promise<{ models: string[] }> {
    return discoverProviderModels({ baseUrl: entry.baseUrl, apiKey: this.key(entry), kind: 'anthropic',
      authType: entry.auth.ANTHROPIC_API_KEY && !entry.auth.ANTHROPIC_AUTH_TOKEN ? 'api-key' : 'bearer' });
  }

  private selectionFromSettings(settings: Settings, registry: ModelRegistry): ModelRegistry['current'] {
    const env = settings.env ?? {};
    const base = env.ANTHROPIC_BASE_URL;
    if (!base) return undefined;
    let model = env.ANTHROPIC_MODEL || settings.model;
    if (!model) return undefined;
    if (/^(sonnet|opus|haiku)$/i.test(model)) model = env[`ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`] || model;
    const auth = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    const matches = Object.entries(registry.keys).filter(([, entry]) =>
      normalizeBaseUrl(entry.baseUrl) === normalizeBaseUrl(base) && Boolean(auth) && this.key(entry) === auth);
    const match = matches.find(([key]) => key === registry.current?.key) ?? matches[0];
    return match ? { key: match[0], model: this.normalizeModel(match[0], model) } : undefined;
  }

  override async current(): Promise<ModelRegistry['current']> {
    return this.selectionFromSettings(parseClaudeSettings(await optionalFile(this.path('settings.json')) ?? '{}'), await this.read());
  }

  protected override async selectionFiles(key: string, model: string, entry: RegistryProvider): Promise<Map<string, string | undefined>> {
    const active = parseClaudeSettings(await optionalFile(this.path('settings.json')) ?? '{}');
    const env = { ...active.env };
    // Never carry another provider's authentication headers to the selected host.
    const sameProvider = env.ANTHROPIC_BASE_URL && normalizeBaseUrl(env.ANTHROPIC_BASE_URL) === normalizeBaseUrl(entry.baseUrl);
    if (!sameProvider) delete env.ANTHROPIC_CUSTOM_HEADERS;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const authField = entry.auth.ANTHROPIC_API_KEY && !entry.auth.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    env[authField] = this.key(entry)!;
    env.ANTHROPIC_BASE_URL = normalizeBaseUrl(entry.baseUrl);
    env.ANTHROPIC_MODEL = model;
    // Explicit defaults prevent restored aliases from invoking a retired model.
    for (const family of ['OPUS', 'SONNET', 'HAIKU']) {
      const previous = env[`ANTHROPIC_DEFAULT_${family}_MODEL`];
      if (family !== 'HAIKU' || !previous || !entry.models.includes(previous)) env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = model;
      delete env[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`];
    }
    const betas = new Set((env.ANTHROPIC_BETAS || '').split(',').map((v) => v.trim()).filter((v) => v && v !== CONTEXT_BETA));
    if (needsContextBeta(key, model)) betas.add(CONTEXT_BETA);
    if (betas.size) env.ANTHROPIC_BETAS = [...betas].join(',');
    else delete env.ANTHROPIC_BETAS;
    const settings = `${JSON.stringify({ ...active, model, env }, null, 2)}\n`;
    const profile = profileName(key, model);
    return new Map([
      ['settings.json', settings], ['.settings-profile', `${profile}\n`],
      [join('settings-profiles', `${profile}.json`), settings],
    ]);
  }

  protected override async resolveLegacy(key: string, registry: ModelRegistry): Promise<ModelRegistry['current']> {
    const text = await optionalFile(this.path(join('settings-profiles', `${key}.json`)));
    if (!text) return undefined;
    const selection = this.selectionFromSettings(parseClaudeSettings(text), registry);
    return selection && registry.keys[selection.key]?.models.includes(selection.model) ? selection : undefined;
  }

  /** The terminal helper uses the same lock, validation, snapshots and rollback. */
  async useSettingsProfile(name: string, sourceDir = this.dir): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) || name.includes('..')) throw new ModelError('配置档名称不正确。');
    await this.mutate(async () => {
      const text = await optionalFile(join(sourceDir, 'settings-profiles', `${name}.json`));
      if (text === undefined) throw new ModelError('没有找到该 Claude 配置档。');
      const settings = parseClaudeSettings(text);
      if (settings.env?.ANTHROPIC_BASE_URL) normalizeBaseUrl(settings.env.ANTHROPIC_BASE_URL);
      if (settings.env?.ANTHROPIC_MODEL) normalizeModelName(settings.env.ANTHROPIC_MODEL);
      const registry = await this.read();
      const current = this.selectionFromSettings(settings, registry);
      if (current) {
        const model = this.normalizeModel(current.key, current.model);
        settings.model = model;
        if (settings.env) {
          const env: Record<string, string> = { ...settings.env, ANTHROPIC_MODEL: model };
          for (const family of ['OPUS', 'SONNET', 'HAIKU']) {
            if (env[`ANTHROPIC_DEFAULT_${family}_MODEL`]) env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = model;
          }
          const betas = new Set((env.ANTHROPIC_BETAS || '').split(',').map((value) => value.trim()).filter((value) => value && value !== CONTEXT_BETA));
          if (needsContextBeta(current.key, model)) betas.add(CONTEXT_BETA);
          if (betas.size) env.ANTHROPIC_BETAS = [...betas].join(',');
          else delete env.ANTHROPIC_BETAS;
          settings.env = env;
        }
      }
      this.remember(registry, await this.current(), current);
      if (current) registry.current = current;
      else delete registry.current;
      const writes = new Map<string, string | undefined>([
        ['settings.json', `${JSON.stringify(settings, null, 2)}\n`], ['.settings-profile', `${name}\n`],
      ]);
      if (await optionalFile(this.path('model-registry.json')) !== undefined) writes.set('model-registry.json', `${JSON.stringify(registry, null, 2)}\n`);
      await this.writeTransaction(writes);
    });
  }
}
