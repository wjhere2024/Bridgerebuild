import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnProcess } from '../../platform/spawn';
import { defaultCodeBuddyBinary } from './adapter';

export interface CodeBuddyModel {
  id: string;
  name: string;
  credits: string;
}

export interface CodeBuddyCatalog {
  models: CodeBuddyModel[];
  currentModelId: string;
  fetchedAt: string;
}

let knownModels: CodeBuddyModel[] = [];
const pending = new Map<string, Promise<CodeBuddyCatalog>>();

export function validCodeBuddyModelId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
}

export function codeBuddyModels(): CodeBuddyModel[] {
  return knownModels.length ? knownModels : [{ id: 'auto', name: 'Auto', credits: '' }];
}

export function rememberCodeBuddyModel(value: string | undefined): void {
  if (value && value !== 'default' && validCodeBuddyModelId(value) && !codeBuddyModels().some((model) => model.id === value)) {
    knownModels = [...codeBuddyModels(), { id: value, name: value, credits: '' }];
  }
}

export function parseCodeBuddyModels(input: unknown): CodeBuddyCatalog {
  const raw = input as { availableModels?: unknown; currentModelId?: unknown } | null;
  if (!raw || !Array.isArray(raw.availableModels)) throw new Error('WorkBuddy 没有返回模型列表。');
  const models: CodeBuddyModel[] = [];
  for (const item of raw.availableModels) {
    if (!item || typeof item !== 'object') continue;
    const model = item as { modelId?: unknown; name?: unknown; _meta?: { credits?: unknown } };
    if (typeof model.modelId !== 'string' || !validCodeBuddyModelId(model.modelId) || model.modelId === 'default' || models.some((entry) => entry.id === model.modelId)) continue;
    models.push({
      id: model.modelId,
      name: typeof model.name === 'string' ? model.name.slice(0, 100) : model.modelId,
      credits: typeof model._meta?.credits === 'string' ? model._meta.credits.trim().slice(0, 80) : '',
    });
  }
  if (!models.length) throw new Error('WorkBuddy 当前账号没有可用模型，请检查登录状态。');
  return { models, currentModelId: typeof raw.currentModelId === 'string' ? raw.currentModelId : '', fetchedAt: new Date().toISOString() };
}

function parseCache(text: string): CodeBuddyCatalog {
  const raw = JSON.parse(text) as CodeBuddyCatalog;
  const catalog = parseCodeBuddyModels({ availableModels: raw.models?.map((model) => ({ modelId: model.id, name: model.name, _meta: { credits: model.credits } })), currentModelId: raw.currentModelId });
  if (!Number.isFinite(Date.parse(raw.fetchedAt))) throw new Error('Invalid catalog date');
  return { ...catalog, fetchedAt: raw.fetchedAt };
}

export function loadCodeBuddyCatalog(profileDir: string): void {
  try { knownModels = parseCache(readFileSync(join(profileDir, 'codebuddy-models.json'), 'utf8')).models; } catch {}
}

export async function discoverCodeBuddyModels(binary = defaultCodeBuddyBinary(), timeoutMs = 20_000): Promise<CodeBuddyCatalog> {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-codebuddy-models-'));
  try {
    return await new Promise<CodeBuddyCatalog>((resolve, reject) => {
      const child = spawnProcess(binary, ['--acp', '--permission-mode', 'plan'], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      let bytes = 0;
      const lines = createInterface({ input: child.stdout! });
      const finish = (error?: Error, catalog?: CodeBuddyCatalog): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.stdin?.end();
        child.kill('SIGTERM');
        const killer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        child.once('close', () => clearTimeout(killer));
        if (error) reject(error); else resolve(catalog!);
      };
      const timer = setTimeout(() => finish(new Error('读取 WorkBuddy 模型列表超时，请稍后刷新。')), timeoutMs);
      const send = (id: number, method: string, params: object): void => {
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      };
      child.stderr?.resume();
      child.stdin?.on('error', () => finish(new Error('WorkBuddy 模型查询连接中断。')));
      child.on('error', () => finish(new Error('无法启动 CodeBuddy CLI，请检查安装路径。')));
      child.on('exit', () => { if (!settled) finish(new Error('WorkBuddy 在返回模型列表前退出，请检查登录状态。')); });
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) finish(new Error('WorkBuddy 模型列表响应过大。'));
      });
      lines.on('line', (line) => {
        if (settled) return;
        let response: { id?: unknown; error?: unknown; result?: { models?: unknown }; method?: unknown };
        try { response = JSON.parse(line); } catch { return; }
        if (response.error && (response.id === 1 || response.id === 2)) {
          finish(new Error('WorkBuddy 拒绝模型查询，请检查账号登录状态后重试。'));
        } else if (response.id === 1 && !response.method) {
          send(2, 'session/new', { cwd: directory, mcpServers: [] });
        } else if (response.id === 2 && !response.method) {
          try { finish(undefined, parseCodeBuddyModels(response.result?.models)); } catch (error) { finish(error as Error); }
        } else if (response.method && response.id !== undefined) {
          child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32601, message: 'Model discovery does not support client operations' } }) + '\n');
        }
      });
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'lark-channel-bridge', version: '0.7.1' } });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function getCodeBuddyCatalog(profileDir: string, force = false): Promise<{ catalog: CodeBuddyCatalog; stale: boolean }> {
  const path = join(profileDir, 'codebuddy-models.json');
  let cached: CodeBuddyCatalog | undefined;
  try { cached = parseCache(await readFile(path, 'utf8')); } catch {}
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 10 * 60_000) {
    knownModels = cached.models;
    return { catalog: cached, stale: false };
  }
  let request = pending.get(path);
  if (!request) {
    request = (async () => {
      const catalog = await discoverCodeBuddyModels();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path + '.tmp', JSON.stringify(catalog), { mode: 0o600 });
      await rename(path + '.tmp', path);
      return catalog;
    })();
    pending.set(path, request);
  }
  try {
    const catalog = await request;
    knownModels = catalog.models;
    return { catalog, stale: false };
  } catch (error) {
    if (!cached) throw error;
    knownModels = cached.models;
    return { catalog: cached, stale: true };
  } finally { if (pending.get(path) === request) pending.delete(path); }
}
