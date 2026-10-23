/**
 * Local AI backend (M5, development only).
 *
 * A tiny dependency-free HTTP server that proxies AI generation to
 * Unlayer's Cloud API (`POST /v3/templates/generate`) while keeping the
 * API key server-side. The browser talks same-origin `/api/ai/*` (via the
 * Vite dev proxy); the key never leaves this process.
 *
 * SECURITY MODEL — read before deploying anywhere:
 * - Binds 127.0.0.1 only. There is NO authentication or rate limiting.
 * - Explicitly restricted to local development. Public deployment requires
 *   auth + rate limiting (see docs/AI_STUDIO.md) — do not expose as-is.
 * - Request/response logs carry sizes and statuses only: never the key,
 *   never prompt text, never design payloads.
 *
 * Run: `npm --prefix app run server` (needs UNLAYER_API_KEY, see
 * `app/.env.example`). Requires Node >= 22.18 (type stripping).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AI_SERVER_DEFAULT_PORT = 5198;
export const AI_SERVER_DEFAULT_TIMEOUT_MS = 120_000;
export const AI_SERVER_DEFAULT_MAX_PROMPT_CHARS = 4000;
export const AI_SERVER_DEFAULT_MAX_DESIGN_BYTES = 4 * 1024 * 1024;
export const AI_SERVER_DEFAULT_MAX_BODY_BYTES = 6_500_000;
export const AI_UPSTREAM_URL = 'https://api.unlayer.com/v3/templates/generate';

export interface ServerConfig {
  apiKey: string;
  projectId?: string;
  port: number;
  upstreamUrl: string;
  timeoutMs: number;
  maxPromptChars: number;
  maxDesignBytes: number;
  maxBodyBytes: number;
  /** Upstream HTTP client. Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/** Minimal `.env` parser (KEY=VALUE, `#` comments, single/double quotes). */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function readDotEnv(cwd: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const dir of [cwd, dirname(cwd)]) {
    const path = join(dir, '.env');
    if (!existsSync(path)) continue;
    try {
      Object.assign(merged, parseEnvText(readFileSync(path, 'utf8')));
    } catch {
      /* ignore unreadable .env files */
    }
  }
  return merged;
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ServerConfig {
  const fileVars = readDotEnv(cwd);
  const get = (key: string): string | undefined => env[key] ?? fileVars[key];
  const apiKey = (get('UNLAYER_API_KEY') ?? '').trim();
  const projectId = (get('UNLAYER_PROJECT_ID') ?? '').trim() || undefined;
  return {
    apiKey,
    projectId,
    port: intOr(get('AI_SERVER_PORT'), AI_SERVER_DEFAULT_PORT),
    upstreamUrl: AI_UPSTREAM_URL,
    timeoutMs: intOr(get('AI_TIMEOUT_MS'), AI_SERVER_DEFAULT_TIMEOUT_MS),
    maxPromptChars: intOr(get('AI_MAX_PROMPT_CHARS'), AI_SERVER_DEFAULT_MAX_PROMPT_CHARS),
    maxDesignBytes: intOr(get('AI_MAX_DESIGN_BYTES'), AI_SERVER_DEFAULT_MAX_DESIGN_BYTES),
    maxBodyBytes: AI_SERVER_DEFAULT_MAX_BODY_BYTES,
  };
}

export interface ValidatedGenerate {
  instruction: string;
  mode: 'create' | 'edit';
  baseDesign: unknown;
}

export type ValidationFailure = { status: 400 | 413; error: string; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateGenerateInput(
  body: unknown,
  limits: { maxPromptChars: number; maxDesignBytes: number },
): { ok: true; value: ValidatedGenerate } | { ok: false; failure: ValidationFailure } {
  if (!isObject(body)) {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: 'Request body must be a JSON object.' } };
  }
  const instruction = typeof body['instruction'] === 'string' ? body['instruction'].trim() : '';
  if (!instruction) {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: 'Instruction must be a non-empty string.' } };
  }
  if (instruction.length > limits.maxPromptChars) {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: `Instruction is too long (max ${limits.maxPromptChars} characters).` } };
  }
  if (body['mode'] !== 'create' && body['mode'] !== 'edit') {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: 'Mode must be "create" or "edit".' } };
  }
  if (!isObject(body['baseDesign'])) {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: 'baseDesign must be a design object.' } };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body['baseDesign']);
  } catch {
    return { ok: false, failure: { status: 400, error: 'invalid_request', message: 'baseDesign could not be serialized.' } };
  }
  if (new TextEncoder().encode(serialized).length > limits.maxDesignBytes) {
    return { ok: false, failure: { status: 413, error: 'payload_too_large', message: 'Design is too large for an AI request.' } };
  }
  return { ok: true, value: { instruction, mode: body['mode'], baseDesign: body['baseDesign'] } };
}

export function buildUpstreamRequest(value: ValidatedGenerate): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: value.instruction }] }],
    output: { kind: 'template', displayMode: 'email' },
    ...(value.mode === 'edit' ? { context: { fullDesign: value.baseDesign } } : {}),
  };
}

export interface UpstreamCall {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type MappedResponse =
  | { status: 200; body: { design: unknown; model?: string; creditsUsed?: number } }
  | { status: 304 }
  | { status: number; body: { error: string; message: string; retryAfterMs?: number; retryable: boolean } };

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function upstreamMessage(body: unknown, fallback: string): string {
  if (isObject(body) && typeof body['message'] === 'string' && body['message']) return body['message'];
  return fallback;
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function failure(status: number, error: string, message: string, retryable: boolean): MappedResponse {
  return { status, body: { error, message, retryable } };
}

export function mapUpstreamResponse(call: UpstreamCall): MappedResponse {
  if (call.status === 304) return { status: 304 };
  const parsed = call.bodyText ? safeJsonParse(call.bodyText) : null;
  if (call.status === 200) {
    const output = isObject(parsed) ? parsed['output'] : undefined;
    const data = isObject(output) ? output['data'] : undefined;
    if (!isObject(data) || !isObject(data['body'])) {
      return { status: 502, body: { error: 'invalid_response', message: 'AI response did not include a design.', retryable: false } };
    }
    const model = isObject(parsed) && isObject(parsed['model']) ? parsed['model'] : undefined;
    const usage = isObject(parsed) && isObject(parsed['usage']) ? parsed['usage'] : undefined;
    const provider = model && typeof model['provider'] === 'string' ? model['provider'] : undefined;
    const modelId = model && typeof model['id'] === 'string' ? model['id'] : undefined;
    const creditsUsed = usage && typeof usage['aiCreditsUsed'] === 'number' ? usage['aiCreditsUsed'] : undefined;
    return {
      status: 200,
      body: {
        design: data,
        ...(provider || modelId ? { model: [provider, modelId].filter(Boolean).join('/') } : {}),
        ...(creditsUsed !== undefined ? { creditsUsed } : {}),
      },
    };
  }
  if (call.status === 401) {
    return failure(401, 'ai_unauthorized', upstreamMessage(parsed, 'Unlayer rejected the API key.'), false);
  }
  if (call.status === 403) {
    return failure(403, 'ai_forbidden', upstreamMessage(parsed, 'Unlayer refused the AI request (plan, credits, or permissions).'), false);
  }
  if (call.status === 429) {
    const retryAfterMs = parseRetryAfter(call.headers);
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: upstreamMessage(parsed, 'AI rate limit reached. Try again shortly.'),
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }
  if (call.status === 400) {
    return failure(400, 'invalid_request', upstreamMessage(parsed, 'AI request was rejected as invalid.'), false);
  }
  if (call.status === 408 || call.status === 504) {
    return failure(502, 'upstream_timeout', 'AI service timed out. Try again.', true);
  }
  if (call.status === 502 || call.status === 503) {
    return failure(502, 'upstream_unavailable', 'AI service is temporarily unavailable. Try again.', true);
  }
  const fallback = typeof call.status === 'number' ? `AI service error (HTTP ${call.status}).` : 'AI service error.';
  return failure(502, 'upstream_error', upstreamMessage(parsed, fallback), true);
}

/** Presence + length only — a key must never appear in logs. */
export function redactAuthHeader(value: string | undefined): string {
  if (!value) return 'missing';
  const token = value.replace(/^Bearer\s+/i, '');
  return token ? `present(len${token.length})` : 'missing';
}

function log(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...details }));
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) resolve({ ok: false });
      else resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => resolve({ ok: false }));
  });
}

async function handleGenerate(req: IncomingMessage, res: ServerResponse, config: ServerConfig): Promise<void> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    sendJson(res, 400, { error: 'invalid_request', message: 'Content-Type must be application/json.' });
    return;
  }
  const raw = await readBody(req, config.maxBodyBytes);
  if (!raw.ok) {
    log('generate.rejected', { reason: 'body_too_large' });
    sendJson(res, 413, { error: 'payload_too_large', message: 'Request body is too large.' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text) as unknown;
  } catch {
    sendJson(res, 400, { error: 'invalid_request', message: 'Request body must be JSON.' });
    return;
  }
  const validated = validateGenerateInput(parsed, config);
  if (!validated.ok) {
    log('generate.rejected', { reason: validated.failure.error });
    sendJson(res, validated.failure.status, { error: validated.failure.error, message: validated.failure.message });
    return;
  }
  if (!config.apiKey) {
    sendJson(res, 501, { error: 'ai_not_configured', message: 'UNLAYER_API_KEY is not set. See docs/AI_STUDIO.md.' });
    return;
  }
  const started = Date.now();
  log('generate.start', { mode: validated.value.mode, promptChars: validated.value.instruction.length });
  const fetchImpl = config.fetchImpl ?? fetch;
  let upstreamStatus = 0;
  try {
    const upstreamRes = await fetchImpl(config.upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.projectId ? { 'X-Project-Id': config.projectId } : {}),
      },
      body: JSON.stringify(buildUpstreamRequest(validated.value)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    upstreamStatus = upstreamRes.status;
    const headers: Record<string, string> = {};
    upstreamRes.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const bodyText = await upstreamRes.text();
    const mapped = mapUpstreamResponse({ status: upstreamRes.status, headers, bodyText });
    log('generate.done', { upstreamStatus, mappedStatus: mapped.status, ms: Date.now() - started });
    if ('body' in mapped) {
      sendJson(res, mapped.status, { ...mapped.body });
    } else {
      res.writeHead(304);
      res.end();
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    log('generate.failed', { reason: timedOut ? 'timeout' : 'network', upstreamStatus });
    sendJson(
      res,
      502,
      timedOut
        ? { error: 'upstream_timeout', message: 'AI service timed out. Try again.', retryable: true }
        : { error: 'upstream_unreachable', message: 'Could not reach the AI service. Try again.', retryable: true },
    );
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: ServerConfig): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    log('status', { configured: config.apiKey !== '' });
    sendJson(res, 200, { configured: config.apiKey !== '' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/generate') {
    await handleGenerate(req, res, config);
    return;
  }
  sendJson(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });
}

export function startServer(overrides?: Partial<ServerConfig>): Server {
  const config = { ...loadConfig(), ...overrides };
  const server = createServer((req, res) => {
    void handleRequest(req, res, config).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error', message: 'Unexpected server error.' });
    });
  });
  server.listen(config.port, '127.0.0.1', () => {
    log('listening', { port: config.port, configured: config.apiKey !== '', auth: redactAuthHeader(config.apiKey ? `Bearer ${config.apiKey}` : undefined) });
  });
  return server;
}

const invokedAsMain = typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsMain) {
  startServer();
}
