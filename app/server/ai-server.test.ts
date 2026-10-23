/**
 * M5 tests for the local AI backend (`./ai-server`).
 *
 * Pure-function coverage (validation, upstream mapping, env parsing) plus
 * live HTTP tests against an ephemeral loopback server. The Unlayer
 * boundary is stubbed via `globalThis.fetch` — no real credentials, no
 * chargeable calls, no network beyond localhost.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';import {
  buildGroqInventory,
  buildGroqUpstreamRequest,
  buildUpstreamRequest,
  loadConfig,
  mapGroqUpstreamResponse,
  mapUpstreamResponse,
  parseEnvText,
  redactAuthHeader,
  startServer,
  validateGenerateInput,
  type ServerConfig,
  type UpstreamCall,
} from './ai-server';

const limits = { maxPromptChars: 4000, maxDesignBytes: 4 * 1024 * 1024 };
const baseDesign = { counters: {}, body: { rows: [] } };

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { instruction: 'A spring sale', mode: 'edit', baseDesign, ...overrides };
}

describe('validateGenerateInput', () => {
  it('accepts well-formed create and edit requests', () => {
    for (const mode of ['create', 'edit']) {
      const result = validateGenerateInput(validBody({ mode }), limits);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects empty, long, or mistyped input', () => {
    expect(validateGenerateInput(validBody({ instruction: '   ' }), limits)).toMatchObject({ ok: false });
    expect(validateGenerateInput(validBody({ mode: 'bogus' }), limits)).toMatchObject({ ok: false });
    expect(validateGenerateInput(null, limits)).toMatchObject({ ok: false });
    expect(validateGenerateInput(validBody({ baseDesign: 'nope' }), limits)).toMatchObject({ ok: false });
    expect(validateGenerateInput(validBody({ instruction: 'x'.repeat(11) }), { ...limits, maxPromptChars: 10 })).toMatchObject({
      ok: false,
      failure: { status: 400 },
    });
    expect(validateGenerateInput(validBody({ baseDesign: { big: 'x'.repeat(100) } }), { ...limits, maxDesignBytes: 10 })).toMatchObject({
      ok: false,
      failure: { status: 413 },
    });
  });
});

describe('buildUpstreamRequest', () => {
  it('targets a full email template and passes the canvas only for edits', () => {
    expect(buildUpstreamRequest({ instruction: 'Hi', mode: 'create', baseDesign })).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      output: { kind: 'template', displayMode: 'email' },
    });
    expect(buildUpstreamRequest({ instruction: 'Hi', mode: 'edit', baseDesign })).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      output: { kind: 'template', displayMode: 'email' },
      context: { fullDesign: baseDesign },
    });
  });
});

describe('mapUpstreamResponse', () => {
  const design = { counters: {}, body: { rows: [] } };

  it('maps successful generations with model and credit metadata', () => {
    const mapped = mapUpstreamResponse({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({
        output: { kind: 'template', data: design },
        model: { provider: 'anthropic', id: 'claude-x' },
        usage: { aiCreditsUsed: 4 },
      }),
    });
    expect(mapped).toEqual({
      status: 200,
      body: { design, model: 'anthropic/claude-x', creditsUsed: 4 },
    });
  });

  it('rejects 200 responses without a usable design', () => {
    for (const bodyText of ['{}', '{"output":{}}', '{"output":{"data":{"noBody":true}}}', 'not-json']) {
      const mapped = mapUpstreamResponse({ status: 200, headers: {}, bodyText });
      expect(mapped).toMatchObject({ status: 502, body: { error: 'invalid_response' } });
    }
  });

  it('passes through no-change as 304', () => {
    expect(mapUpstreamResponse({ status: 304, headers: {}, bodyText: '' })).toEqual({ status: 304 });
  });

  it('maps auth, forbidden, and rate-limit failures with messages', () => {
    expect(
      mapUpstreamResponse({ status: 401, headers: {}, bodyText: JSON.stringify({ error: 'x', message: 'Bad key.' }) }),
    ).toMatchObject({ status: 401, body: { error: 'ai_unauthorized', message: 'Bad key.' } });
    expect(
      mapUpstreamResponse({ status: 403, headers: {}, bodyText: JSON.stringify({ message: 'No credits left.' }) }),
    ).toMatchObject({ status: 403, body: { error: 'ai_forbidden', message: 'No credits left.' } });
    const limited = mapUpstreamResponse({
      status: 429,
      headers: { 'retry-after': '2' },
      bodyText: JSON.stringify({ message: 'Slow down.' }),
    });
    expect(limited).toMatchObject({
      status: 429,
      body: { error: 'rate_limited', retryAfterMs: 2000, retryable: true },
    });
    const noHeader = mapUpstreamResponse({ status: 429, headers: {}, bodyText: '{}' });
    expect(noHeader).toMatchObject({ status: 429 });
    expect('retryAfterMs' in (noHeader as { body: Record<string, unknown> }).body).toBe(false);
  });

  it('maps upstream outages as retryable 502s', () => {
    for (const status of [408, 502, 503, 504, 500]) {
      expect(mapUpstreamResponse({ status, headers: {}, bodyText: '{}' })).toMatchObject({
        status: 502,
        body: { retryable: true },
      });
    }
  });
});

describe('parseEnvText and loadConfig', () => {
  it('parses env files with quotes and comments', () => {
    expect(
      parseEnvText('# comment\nUNLAYER_API_KEY="sk-live-123"\nEMPTY=\nINVALID LINE\nUNLAYER_PROJECT_ID=proj_1\n'),
    ).toEqual({ UNLAYER_API_KEY: 'sk-live-123', EMPTY: '', UNLAYER_PROJECT_ID: 'proj_1' });
  });

  it('loads defaults and explicit env without touching the real environment', () => {
    const defaults = loadConfig({}, '/nonexistent-dir-xyz');
    expect(defaults.apiKey).toBe('');
    expect(defaults.port).toBe(5198);
    expect(defaults.upstreamUrl).toBe('https://api.unlayer.com/v3/templates/generate');

    const custom = loadConfig({ UNLAYER_API_KEY: '  sk  ', AI_SERVER_PORT: '1234' }, '/nonexistent-dir-xyz');
    expect(custom.apiKey).toBe('sk');
    expect(custom.port).toBe(1234);
  });

  it('redacts authorization values', () => {
    const redacted = redactAuthHeader('Bearer unlayer_sk_abcdef123456');
    expect(redacted).not.toContain('unlayer_sk_abcdef123456');
    expect(redacted).toContain('present');
    expect(redactAuthHeader(undefined)).toBe('missing');
  });
});

describe('ai-server HTTP surface', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  async function listenWith(config: Partial<ServerConfig>): Promise<string> {
    const server = startServer({ port: 0, ...config });
    servers.push(server);
    const address = await new Promise<unknown>((resolve) => {
      const check = (): void => {
        const current: unknown = server.address();
        if (current) resolve(current);
        else setTimeout(check, 50);
      };
      check();
    });
    const port = (address as { port: number }).port;
    return `http://127.0.0.1:${port}`;
  }

  it('reports configuration without leaking secrets', async () => {
    const base = await listenWith({ apiKey: '' });
    const response = await fetch(`${base}/api/ai/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ configured: false });
  });

  it('rejects invalid bodies and missing keys without contacting Unlayer', async () => {
    const upstream = vi.fn(async (): Promise<Response> => {
      throw new Error('must not call upstream');
    });
    const base = await listenWith({ apiKey: '', fetchImpl: upstream });

    const bad = await fetch(`${base}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: '' }),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(`${base}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Hi', mode: 'edit', baseDesign }),
    });
    expect(missing.status).toBe(501);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody.error).toBe('ai_not_configured');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('proxies generation and maps upstream failures', async () => {
    const seen: Array<{ auth: string | null; body: unknown }> = [];
    const upstream = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({ auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(
        JSON.stringify({ output: { kind: 'template', data: baseDesign }, usage: { aiCreditsUsed: 2 } }),
        { status: 200 },
      );
    });
    const base = await listenWith({ apiKey: 'SENTINEL-SECRET-XYZ', fetchImpl: upstream });
    const response = await fetch(`${base}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Hi', mode: 'edit', baseDesign }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ design: baseDesign, creditsUsed: 2 });
    expect(JSON.stringify(body)).not.toContain('SENTINEL-SECRET-XYZ');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer SENTINEL-SECRET-XYZ');
    expect(seen[0].body).toMatchObject({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      output: { kind: 'template', displayMode: 'email' },
    });

    const upstream429 = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ message: 'Slow.' }), { status: 429 }));
    const base429 = await listenWith({ apiKey: 'SENTINEL-SECRET-XYZ', fetchImpl: upstream429 });
    const limited = await fetch(`${base429}/api/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Hi', mode: 'edit', baseDesign }),
    });
    expect(limited.status).toBe(429);
  });

  it('returns 404 for unknown routes', async () => {
    const base = await listenWith({ apiKey: '' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('groq provider config', () => {
  it('defaults the model and trims the key override', () => {
    const defaults = loadConfig({}, '/nonexistent-dir-xyz');
    expect(defaults.groqApiKey).toBe('');
    expect(defaults.groqModel).toBe('openai/gpt-oss-20b');
    expect(defaults.groqUpstreamUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    const custom = loadConfig({ GROQ_API_KEY: '  gsk-test  ', GROQ_MODEL: 'openai/gpt-oss-120b' }, '/nonexistent-dir-xyz');
    expect(custom.groqApiKey).toBe('gsk-test');
    expect(custom.groqModel).toBe('openai/gpt-oss-120b');
  });
});

describe('buildGroqInventory', () => {
  const textJson = (text: string): string =>
    JSON.stringify({ root: { children: [{ children: [{ text }] }] } });
  const design = {
    counters: {},
    body: {
      rows: [
        {
          id: 'row-0',
          cells: [1],
          columns: [
            {
              id: 'row-0-col-0',
              contents: [
                { id: 'p1', type: 'paragraph', values: { text: '<p>Hello</p>', textJson: textJson('Hello') } },
                { id: 'img-1', type: 'image', values: { src: 'https://example.com/y.png' } },
                { id: 'p2', type: 'paragraph', values: { text: '<p>Locked</p>', textJson: textJson('Locked'), locked: true } },
              ],
              values: {},
            },
          ],
          values: {},
        },
      ],
      values: {},
    },
  };

  it('lists editable paragraphs and skips anything else', () => {
    expect(buildGroqInventory(design)).toEqual([{ id: 'p1', text: 'Hello' }]);
  });

  it('returns [] for uninspectable input and truncates long text', () => {
    expect(buildGroqInventory(null)).toEqual([]);
    expect(buildGroqInventory({})).toEqual([]);
    const long = 'z'.repeat(500);
    const entries = buildGroqInventory(
      { counters: {}, body: { rows: [{ id: 'r', cells: [1], columns: [{ id: 'c', contents: [{ id: 'p', type: 'paragraph', values: { text: `<p>${long}</p>`, textJson: textJson(long) } }], values: {} }], values: {} }], values: {} } },
    );
    expect(entries[0].text.length).toBeLessThan(long.length);
  });
});

describe('buildGroqUpstreamRequest', () => {
  it('targets chat completions with strict structured outputs and no secrets', () => {
    const body = buildGroqUpstreamRequest({
      instruction: 'Make it friendlier',
      inventory: [{ id: 'p1', text: 'Hello' }],
      model: 'openai/gpt-oss-20b',
    });
    expect(body['model']).toBe('openai/gpt-oss-20b');
    expect(body['temperature']).toBe(0);
    expect(body).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'user', content: 'Make it friendlier' });
    expect(messages[0].content).toContain('p1');
    expect(JSON.stringify(body)).not.toContain('gsk-');
  });
});

describe('mapGroqUpstreamResponse', () => {
  const ids = ['p1', 'p2'];
  const groq200 = (content: unknown, model = 'openai/gpt-oss-20b'): UpstreamCall => ({
    status: 200,
    headers: {},
    bodyText: JSON.stringify({ model, choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
  });

  it('maps valid operations with dropped entries and the model name', () => {
    const mapped = mapGroqUpstreamResponse(
      groq200({ operations: [{ op: 'set_paragraph_text', blockId: 'p1', text: 'Hi' }, { op: 'nope', blockId: 'p1', text: 'x' }] }),
      ids,
    );
    expect(mapped).toMatchObject({
      status: 200,
      body: { operations: [{ op: 'set_paragraph_text', blockId: 'p1', text: 'Hi' }], model: 'openai/gpt-oss-20b' },
    });
  });

  it('passes empty operation lists through and rejects unusable output', () => {
    expect(mapGroqUpstreamResponse(groq200({ operations: [] }), ids)).toMatchObject({ status: 200, body: { operations: [] } });
    expect(
      mapGroqUpstreamResponse(groq200({ operations: [{ op: 'set_paragraph_text', blockId: 'ghost', text: 'Hi' }] }), ids),
    ).toMatchObject({ status: 502, body: { error: 'invalid_response' } });
    for (const bodyText of ['not-json', '{}', JSON.stringify({ choices: [] })]) {
      expect(mapGroqUpstreamResponse({ status: 200, headers: {}, bodyText }, ids)).toMatchObject({
        status: 502,
        body: { error: 'invalid_response', retryable: false },
      });
    }
  });

  it('maps auth, forbidden, rate-limit, and outage statuses', () => {
    expect(mapGroqUpstreamResponse({ status: 401, headers: {}, bodyText: '{}' }, ids)).toMatchObject({
      status: 401,
      body: { error: 'groq_unauthorized', retryable: false },
    });
    expect(mapGroqUpstreamResponse({ status: 403, headers: {}, bodyText: '{}' }, ids)).toMatchObject({
      status: 403,
      body: { error: 'groq_forbidden', retryable: false },
    });
    expect(
      mapGroqUpstreamResponse({ status: 429, headers: { 'retry-after': '3' }, bodyText: '{}' }, ids),
    ).toMatchObject({ status: 429, body: { error: 'rate_limited', retryAfterMs: 3000, retryable: true } });
    expect(mapGroqUpstreamResponse({ status: 400, headers: {}, bodyText: '{}' }, ids)).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', retryable: false },
    });
    for (const status of [408, 502, 503, 504, 500]) {
      expect(mapGroqUpstreamResponse({ status, headers: {}, bodyText: '{}' }, ids)).toMatchObject({
        status: 502,
        body: { retryable: true },
      });
    }
  });
});

describe('groq HTTP surface', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  async function listenWithGroq(config: Partial<ServerConfig>): Promise<string> {
    const server = startServer({ port: 0, ...config });
    servers.push(server);
    const address = await new Promise<unknown>((resolve) => {
      const check = (): void => {
        const current: unknown = server.address();
        if (current) resolve(current);
        else setTimeout(check, 50);
      };
      check();
    });
    return `http://127.0.0.1:${(address as { port: number }).port}`;
  }

  it('reports groq configuration with the model name and no secrets', async () => {
    const off = await listenWithGroq({ groqApiKey: '' });
    expect(((await (await fetch(`${off}/api/ai/groq-status`)).json()) as Record<string, unknown>)).toEqual({
      configured: false,
      model: 'openai/gpt-oss-20b',
    });
    const on = await listenWithGroq({ groqApiKey: 'SENTINEL-GROQ-XYZ' });
    const body = ((await (await fetch(`${on}/api/ai/groq-status`)).json()) as Record<string, unknown>);
    expect(body).toEqual({ configured: true, model: 'openai/gpt-oss-20b' });
    expect(JSON.stringify(body)).not.toContain('SENTINEL-GROQ-XYZ');
  });

  it('rejects unconfigured keys, create mode, and empty inventories upstream-free', async () => {
    const upstream = vi.fn(async (): Promise<Response> => {
      throw new Error('must not call upstream');
    });
    const base = await listenWithGroq({ groqApiKey: '', fetchImpl: upstream });
    const post = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/ai/groq-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const missing = await post({ instruction: 'Hi', mode: 'edit', baseDesign });
    expect(missing.status).toBe(501);
    expect(((await missing.json()) as Record<string, unknown>).error).toBe('groq_not_configured');

    const keyed = await listenWithGroq({ groqApiKey: 'SENTINEL-GROQ-XYZ', fetchImpl: upstream });
    const postKeyed = (body: unknown): Promise<Response> =>
      fetch(`${keyed}/api/ai/groq-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const create = await postKeyed({ instruction: 'Hi', mode: 'create', baseDesign });
    expect(create.status).toBe(400);
    const empty = await postKeyed({ instruction: 'Hi', mode: 'edit', baseDesign: { counters: {}, body: { rows: [] } } });
    expect(empty.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('proxies edit operations with strict schema and Bearer auth', async () => {
    const seen: Array<{ auth: string | null; body: unknown }> = [];
    const upstream = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({ auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(
        JSON.stringify({
          model: 'openai/gpt-oss-20b',
          choices: [{ message: { content: JSON.stringify({ operations: [{ op: 'set_paragraph_text', blockId: 'p1', text: 'Hi' }] }) } }],
        }),
        { status: 200 },
      );
    });
    const textJson = JSON.stringify({ root: { children: [{ children: [{ text: 'Hello' }] }] } });
    const withPara = {
      counters: {},
      body: {
        rows: [
          {
            id: 'row-0',
            cells: [1],
            columns: [{ id: 'c0', contents: [{ id: 'p1', type: 'paragraph', values: { text: '<p>Hello</p>', textJson } }], values: {} }],
            values: {},
          },
        ],
        values: {},
      },
    };
    const base = await listenWithGroq({ groqApiKey: 'SENTINEL-GROQ-XYZ', fetchImpl: upstream });
    const response = await fetch(`${base}/api/ai/groq-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Greet', mode: 'edit', baseDesign: withPara }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ operations: [{ op: 'set_paragraph_text', blockId: 'p1', text: 'Hi' }], model: 'openai/gpt-oss-20b' });
    expect(JSON.stringify(body)).not.toContain('SENTINEL-GROQ-XYZ');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer SENTINEL-GROQ-XYZ');
    expect(seen[0].body).toMatchObject({
      model: 'openai/gpt-oss-20b',
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
  });
});
