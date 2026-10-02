import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverProviderModels, normalizeBaseUrl } from '../../../src/model/discovery';

afterEach(() => vi.unstubAllGlobals());

describe('provider model discovery', () => {
  it('normalizes full completion URLs and preserves model case and slashes', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'Vendor/Model-A' }, { id: 'Vendor/Model-A' }, { id: 'other' }, { id: 'bad\nmodel' },
    ] })));
    vi.stubGlobal('fetch', fetcher);
    const result = await discoverProviderModels({ baseUrl: 'https://example.test/v1/chat/completions', apiKey: 'fixture-secret', kind: 'openai' });
    expect(result.models).toEqual(['other', 'Vendor/Model-A']);
    expect(fetcher).toHaveBeenCalledWith('https://example.test/v1/models', expect.objectContaining({
      redirect: 'error', headers: { accept: 'application/json', authorization: 'Bearer fixture-secret' },
    }));
  });

  it('tries the alternate models path only for a missing endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: ['CaseSensitive'] })));
    vi.stubGlobal('fetch', fetcher);
    expect((await discoverProviderModels({ baseUrl: 'https://example.test', apiKey: 'fixture', kind: 'openai' })).models).toEqual(['CaseSensitive']);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://example.test/v1/models', 'https://example.test/models']);
  });

  it('never repeats provider error bodies or credentials', async () => {
    const fetcher = vi.fn(async () => new Response('server echoed fixture-secret', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(discoverProviderModels({ baseUrl: 'https://example.test', apiKey: 'fixture-secret', kind: 'openai' })).rejects.toThrow('HTTP 401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid lists and oversize content', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('fixture-secret is not JSON'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
      .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    vi.stubGlobal('fetch', fetcher);
    const request = { baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret', kind: 'openai' as const };
    await expect(discoverProviderModels(request)).rejects.toThrow('有效 JSON');
    await expect(discoverProviderModels(request)).rejects.toThrow('可用的模型名称');
    await expect(discoverProviderModels(request)).rejects.toThrow('2 MiB');
  });

  it('uses the Anthropic auth header and aborts requests on timeout', async () => {
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('request fixture-secret timed out')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    await expect(discoverProviderModels({ baseUrl: 'https://example.test', apiKey: 'fixture-secret', kind: 'anthropic', timeoutMs: 10 })).rejects.toThrow('超时');
    expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({ 'x-api-key': 'fixture-secret', 'anthropic-version': '2023-06-01' });
  });

  it('rejects credentials, query strings and unsupported protocols in a base URL', () => {
    for (const url of ['https://user:secret@example.test', 'https://example.test?key=secret', 'file:///tmp/test']) {
      expect(() => normalizeBaseUrl(url)).toThrow();
    }
  });
});
