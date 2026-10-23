/**
 * M5 tests for the AI provider client (`./aiProvider`).
 *
 * The Unlayer boundary is mocked (`fetchFn` injection): these tests verify
 * OUR request building, response mapping, timeout/cancel behavior, and —
 * critically — that no secrets ever leave the browser.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AI_ENDPOINT,
  requestAiGeneration,
  checkAiStatus,
  type AiGenerateInput,
} from './aiProvider';

const input: AiGenerateInput = {
  instruction: 'A spring sale announcement',
  mode: 'edit',
  baseDesign: { counters: {}, body: { rows: [] } },
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function captureFetch(response: Response | ((url: unknown, init?: RequestInit) => Promise<Response> | Response)) {
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  });
  return { fetchFn, calls };
}

const validDesign = { counters: {}, body: { rows: [] }, schemaVersion: 28 };

describe('requestAiGeneration', () => {
  it('returns a ready design with model and credit metadata', async () => {
    const { fetchFn } = captureFetch(
      jsonResponse(200, { design: validDesign, model: 'anthropic/claude-opus', creditsUsed: 3 }),
    );
    const result = await requestAiGeneration(input, { fetchFn });

    expect(result).toEqual({ status: 'ready', design: validDesign, model: 'anthropic/claude-opus', creditsUsed: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects unusable 200 responses without applying anything', async () => {
    for (const body of [{}, { design: null }, { design: { noBody: true } }, { output: { data: 'nope' } }]) {
      const { fetchFn } = captureFetch(jsonResponse(200, body));
      const result = await requestAiGeneration(input, { fetchFn });
      expect(result).toMatchObject({ status: 'error', code: 'invalid_response', retryable: false });
    }
  });

  it('maps a 304 response to no-change', async () => {
    const { fetchFn } = captureFetch(new Response(null, { status: 304 }));
    expect(await requestAiGeneration(input, { fetchFn })).toEqual({ status: 'no-change' });
  });

  it('maps missing credentials without inventing results', async () => {
    const { fetchFn } = captureFetch(jsonResponse(501, { error: 'ai_not_configured', message: 'Set a key.' }));
    expect(await requestAiGeneration(input, { fetchFn })).toEqual({ status: 'not-configured' });
  });

  it('maps authorization, forbidden, and rate-limit failures', async () => {
    const cases: Array<{ status: number; body: unknown; code: string; retryable: boolean }> = [
      { status: 401, body: { error: 'ai_unauthorized', message: 'Bad key.' }, code: 'unauthorized', retryable: false },
      { status: 403, body: { error: 'ai_forbidden', message: 'No credits.' }, code: 'forbidden', retryable: false },
      { status: 429, body: { error: 'rate_limited', message: 'Slow down.', retryAfterMs: 2000 }, code: 'rate_limited', retryable: true },
      { status: 400, body: { error: 'invalid_request', message: 'Bad input.' }, code: 'invalid_request', retryable: false },
    ];
    for (const { status, body, code, retryable } of cases) {
      const { fetchFn } = captureFetch(jsonResponse(status, body));
      const result = await requestAiGeneration(input, { fetchFn });
      expect(result).toMatchObject({ status: 'error', code, retryable });
    }
  });

  it('forwards the server retry-after hint', async () => {
    const { fetchFn } = captureFetch(jsonResponse(429, { error: 'rate_limited', message: 'Slow.', retryAfterMs: 2000 }));
    const result = await requestAiGeneration(input, { fetchFn });
    expect(result).toEqual({ status: 'error', code: 'rate_limited', message: 'Slow.', retryable: true, retryAfterMs: 2000 });
  });

  it('times out slowly-hanging requests without retrying automatically', async () => {
    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('AbortError', 'AbortError')));
        }),
    );
    const result = await requestAiGeneration(input, { fetchFn: hanging, timeoutMs: 50 });
    expect(result).toMatchObject({ status: 'error', code: 'timeout', retryable: true });
  });

  it('reports unreachable backends', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await requestAiGeneration(input, { fetchFn: failing });
    expect(result).toMatchObject({ status: 'error', code: 'network', retryable: true });
  });

  it('distinguishes user cancellation from timeouts', async () => {
    const aborting = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return jsonResponse(200, { design: validDesign });
    });
    const controller = new AbortController();
    controller.abort();
    const result = await requestAiGeneration(input, { fetchFn: aborting, signal: controller.signal });
    expect(result).toEqual({ status: 'error', code: 'cancelled', message: 'AI request cancelled.', retryable: false });
  });

  it('throws displayable errors for invalid input', async () => {
    const { fetchFn } = captureFetch(jsonResponse(200, { design: validDesign }));
    await expect(requestAiGeneration({ ...input, instruction: '   ' }, { fetchFn })).rejects.toThrow('Enter an AI instruction first.');
    await expect(requestAiGeneration({ ...input, instruction: 'x'.repeat(4001) }, { fetchFn })).rejects.toThrow('too long');
    await expect(requestAiGeneration({ ...input, mode: 'bogus' as never }, { fetchFn })).rejects.toThrow('Unknown generation mode');
    await expect(requestAiGeneration({ ...input, baseDesign: { big: 'x'.repeat(5 * 1024 * 1024) } }, { fetchFn })).rejects.toThrow('too large');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never sends secrets and stays same-origin', async () => {
    const { fetchFn, calls } = captureFetch(jsonResponse(200, { design: validDesign }));
    await requestAiGeneration(input, { fetchFn });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(String(call.url)).toBe(AI_ENDPOINT);
    expect(String(call.url).startsWith('/')).toBe(true);
    const headers = new Headers(call.init?.headers);
    expect([...headers.keys()].some((name) => name.toLowerCase() === 'authorization')).toBe(false);
    const bodyText = String(call.init?.body ?? '');
    expect(bodyText).not.toMatch(/api[_-]?key|secret|token|bearer/i);
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['baseDesign', 'instruction', 'mode']);
  });
});

describe('checkAiStatus', () => {
  it('reports configured, unconfigured, and unreachable backends', async () => {
    expect(await checkAiStatus(async () => jsonResponse(200, { configured: true }))).toBe(true);
    expect(await checkAiStatus(async () => jsonResponse(200, { configured: false }))).toBe(false);
    expect(await checkAiStatus(async () => jsonResponse(200, { nope: 1 }))).toBe(false);
    expect(
      await checkAiStatus(async () => {
        throw new TypeError('down');
      }),
    ).toBe(false);
  });
});
