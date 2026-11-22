import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnProcess } from '../../platform/spawn';

export interface AntigravityModel {
  id: string;
  name: string;
}

export interface AntigravityCatalog {
  models: AntigravityModel[];
  fetchedAt: string;
}

let knownModels: AntigravityModel[] = [];
const pending = new Map<string, Promise<AntigravityCatalog>>();

export function validAntigravityModelId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
}

export function antigravityModels(): AntigravityModel[] {
  return knownModels;
}

export function rememberAntigravityModel(value: string | undefined): void {
  if (value && value !== 'default' && validAntigravityModelId(value) && !antigravityModels().some((model) => model.id === value)) {
    knownModels = [...antigravityModels(), { id: value, name: value }];
  }
}

/**
 * Parse `agy models` stdout. Lines are `model-id<TAB>Display Name`;
 * the first line is a progress message ("Fetching available models...")
 * and is skipped. The list comes from the logged-in Google account, so
 * it changes when the account changes — never hard-code it.
 */
export function parseAntigravityModels(text: string): AntigravityCatalog {
  const models: AntigravityModel[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Fetching')) continue;
    const [id, ...nameParts] = trimmed.split('\t');
    const modelId = (id ?? '').trim();
    if (!validAntigravityModelId(modelId) || modelId === 'default' || models.some((entry) => entry.id === modelId)) continue;
    const name = nameParts.join(' ').trim().slice(0, 100);
    models.push({ id: modelId, name: name || modelId });
  }
  if (!models.length) throw new Error('Antigravity 当前账号没有可用模型，请检查登录状态。');
  return { models, fetchedAt: new Date().toISOString() };
}

function parseCache(text: string): AntigravityCatalog {
  const raw = JSON.parse(text) as AntigravityCatalog;
  const catalog = parseAntigravityModels(raw.models?.map((model) => `${model.id}\t${model.name}`).join('\n') ?? '');
  if (!Number.isFinite(Date.parse(raw.fetchedAt))) throw new Error('Invalid catalog date');
  return { ...catalog, fetchedAt: raw.fetchedAt };
}

export function loadAntigravityCatalog(profileDir: string): void {
  try { knownModels = parseCache(readFileSync(join(profileDir, 'antigravity-models.json'), 'utf8')).models; } catch {}
}

export async function discoverAntigravityModels(binary: string, timeoutMs = 20_000): Promise<AntigravityCatalog> {
  return new Promise<AntigravityCatalog>((resolve, reject) => {
    const child = spawnProcess(binary, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const finish = (error?: Error, catalog?: AntigravityCatalog): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      const killer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
      child.once('close', () => clearTimeout(killer));
      if (error) reject(error); else resolve(catalog!);
    };
    const timer = setTimeout(() => finish(new Error('读取 Antigravity 模型列表超时，请稍后刷新。')), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { finish(new Error('Antigravity 模型列表响应过大。')); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => finish(new Error('无法启动 Antigravity CLI，请检查安装路径。')));
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`Antigravity 模型查询失败（退出码 ${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 120)}` : '，请检查登录状态。'}`)); return; }
      try { finish(undefined, parseAntigravityModels(stdout)); } catch (error) { finish(error as Error); }
    });
  });
}

export async function getAntigravityCatalog(profileDir: string, binary: string, force = false): Promise<{ catalog: AntigravityCatalog; stale: boolean }> {
  const path = join(profileDir, 'antigravity-models.json');
  let cached: AntigravityCatalog | undefined;
  try { cached = parseCache(await readFile(path, 'utf8')); } catch {}
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 10 * 60_000) {
    knownModels = cached.models;
    return { catalog: cached, stale: false };
  }
  let request = pending.get(path);
  if (!request) {
    request = (async () => {
      const catalog = await discoverAntigravityModels(binary);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path + '.tmp', JSON.stringify(catalog), { mode: 0o600 });
      await rename(path + '.tmp', path);
      knownModels = catalog.models;
      return catalog;
    })();
    pending.set(path, request);
    request.finally(() => { if (pending.get(path) === request) pending.delete(path); }).catch(() => {});
  }
  try {
    return { catalog: await request, stale: false };
  } catch (error) {
    if (cached) return { catalog: cached, stale: true };
    throw error;
  }
}
