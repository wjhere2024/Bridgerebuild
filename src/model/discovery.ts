export type ModelApiKind = 'openai' | 'anthropic';

/** Only deliberately constructed, credential-free messages may reach chat. */
export class ModelError extends Error {}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ModelError('Base URL 格式不正确。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelError('Base URL 须为 http 或 https 地址，不能包含账号、密码、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '');
  return url.toString().replace(/\/+$/, '');
}

export function normalizeModelName(value: string): string {
  const model = value.trim();
  if (!model || model.length > 128 || /[\s\x00-\x1f\x7f<>`]/.test(model)) {
    throw new ModelError('模型名称须为 1 至 128 位，不能包含空白或控制字符。');
  }
  return model;
}

function endpoints(baseUrl: string): string[] {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/v\d+(?:beta)?$/.test(base)) return [`${base}/models`];
  return new URL(base).pathname === '/'
    ? [`${base}/v1/models`, `${base}/models`]
    : [`${base}/models`, `${base}/v1/models`];
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ModelError('模型接口返回了空内容。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 2 * 1024 * 1024) throw new ModelError('模型列表超过 2 MiB 限制。');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ModelError('模型接口未返回有效 JSON。');
  }
}

/** GET only; redirects are rejected so credentials never follow another host. */
export async function discoverProviderModels(input: {
  baseUrl: string;
  apiKey?: string;
  kind: ModelApiKind;
  authType?: 'bearer' | 'api-key';
  timeoutMs?: number;
}): Promise<{ models: string[] }> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey || /[\x00-\x1f\x7f]/.test(apiKey)) throw new ModelError('未找到有效的 API Key，请检查服务商认证。');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.kind === 'anthropic') {
    if (input.authType === 'bearer') headers.authorization = `Bearer ${apiKey}`;
    else headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const signal = AbortSignal.timeout(input.timeoutMs ?? 12_000);
  const urls = endpoints(input.baseUrl);
  try {
    for (const [index, url] of urls.entries()) {
      const response = await fetch(url, { headers, signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        if ([404, 405].includes(response.status) && index < urls.length - 1) continue;
        throw new ModelError(`模型接口返回 HTTP ${response.status}。`);
      }
      const body = await readJson(response);
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const items = Array.isArray(body) ? body : record.data ?? record.models;
      if (!Array.isArray(items)) throw new ModelError('模型接口没有提供模型列表。');
      const models = new Set<string>();
      for (const item of items) {
        const id = typeof item === 'string' ? item : item?.id ?? item?.name;
        if (typeof id !== 'string') continue;
        try { models.add(normalizeModelName(id)); } catch { /* Skip malformed entries. */ }
      }
      if (!models.size) throw new ModelError('模型接口没有返回可用的模型名称。');
      return { models: [...models].sort((a, b) => a.localeCompare(b)) };
    }
    throw new ModelError('未找到模型列表接口。');
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError(signal.aborted ? '获取模型列表超时。' : '无法连接模型接口，请检查地址、网络和认证。');
  }
}
