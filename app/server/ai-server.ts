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
export const GROQ_UPSTREAM_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';
export const GROQ_MAX_OPS = 10;
export const GROQ_MAX_TEXT_CHARS = 2000;
export const GROQ_MAX_INVENTORY_BLOCKS = 20;
export const GROQ_MAX_INVENTORY_TEXT_CHARS = 300;
export const GROQ_MAX_COMPLETION_TOKENS = 2000;

export interface ServerConfig {
  apiKey: string;
  projectId?: string;
  port: number;
  upstreamUrl: string;
  timeoutMs: number;
  maxPromptChars: number;
  maxDesignBytes: number;
  maxBodyBytes: number;
  /** Groq BYOM provider (M8). Empty key = unconfigured; never leaves this process. */
  groqApiKey: string;
  /** Overridable via GROQ_MODEL; must support structured outputs. */
  groqModel: string;
  groqUpstreamUrl: string;
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
  const groqModel = (get('GROQ_MODEL') ?? '').trim() || GROQ_DEFAULT_MODEL;
  return {
    apiKey,
    projectId,
    port: intOr(get('AI_SERVER_PORT'), AI_SERVER_DEFAULT_PORT),
    upstreamUrl: AI_UPSTREAM_URL,
    timeoutMs: intOr(get('AI_TIMEOUT_MS'), AI_SERVER_DEFAULT_TIMEOUT_MS),
    maxPromptChars: intOr(get('AI_MAX_PROMPT_CHARS'), AI_SERVER_DEFAULT_MAX_PROMPT_CHARS),
    maxDesignBytes: intOr(get('AI_MAX_DESIGN_BYTES'), AI_SERVER_DEFAULT_MAX_DESIGN_BYTES),
    maxBodyBytes: AI_SERVER_DEFAULT_MAX_BODY_BYTES,
    groqApiKey: (get('GROQ_API_KEY') ?? '').trim(),
    groqModel,
    groqUpstreamUrl: GROQ_UPSTREAM_URL,
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

/* ------------------------------------------------------------------ */
/* Groq BYOM provider (M8).                                            */
/*                                                                     */
/* Same trust model as the Unlayer path: the key lives only in this   */
/* process, validation is shared, and the model returns constrained   */
/* paragraph EDIT OPERATIONS (never full-design JSON). The inventory   */
/* walk below mirrors `buildParagraphInventory` in `src/ai/groqOps.ts` */
/* (kept separate so the backend never imports frontend engine code). */
/* The engine re-validates every operation before anything reaches    */
/* the canvas — this layer only keeps garbage from crossing the wire. */
/* ------------------------------------------------------------------ */

export interface GroqInventoryEntry {
  id: string;
  text: string;
}

function groqLexicalFirstText(textJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(textJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = (parsed as Record<string, unknown>)['root'];
    if (root === null || typeof root !== 'object' || Array.isArray(root)) return null;
    const children = (root as Record<string, unknown>)['children'];
    if (!Array.isArray(children)) return null;
    const first = children[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
    const inner = (first as Record<string, unknown>)['children'];
    if (!Array.isArray(inner)) return null;
    const node = inner[0];
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    const text = (node as Record<string, unknown>)['text'];
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Editable-paragraph inventory for the model prompt. Never throws. */
export function buildGroqInventory(
  design: unknown,
  limits: { maxBlocks?: number; maxTextChars?: number } = {},
): GroqInventoryEntry[] {
  const maxBlocks = limits.maxBlocks ?? GROQ_MAX_INVENTORY_BLOCKS;
  const maxTextChars = limits.maxTextChars ?? GROQ_MAX_INVENTORY_TEXT_CHARS;
  const entries: GroqInventoryEntry[] = [];
  try {
    if (design === null || typeof design !== 'object' || Array.isArray(design)) return [];
    const body = (design as Record<string, unknown>)['body'];
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
    const sections: Array<{ rows: unknown; prefix: string }> = [{ rows: (body as Record<string, unknown>)['rows'], prefix: 'rows' }];
    const record = body as Record<string, unknown>;
    if (record['headers'] !== undefined) sections.push({ rows: record['headers'], prefix: 'headers' });
    if (record['footers'] !== undefined) sections.push({ rows: record['footers'], prefix: 'footers' });
    for (const section of sections) {
      if (!Array.isArray(section.rows)) continue;
      for (const row of section.rows) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
        const columns = (row as Record<string, unknown>)['columns'];
        if (!Array.isArray(columns)) continue;
        for (const column of columns) {
          if (column === null || typeof column !== 'object' || Array.isArray(column)) continue;
          const contents = (column as Record<string, unknown>)['contents'];
          if (!Array.isArray(contents)) continue;
          for (const block of contents) {
            if (entries.length >= maxBlocks) return entries;
            if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
            const candidate = block as Record<string, unknown>;
            if (typeof candidate['id'] !== 'string' || !candidate['id']) continue;
            if (candidate['type'] !== 'paragraph') continue;
            const values = candidate['values'];
            if (values === null || typeof values !== 'object' || Array.isArray(values)) continue;
            const fields = values as Record<string, unknown>;
            if (fields['locked'] || typeof fields['text'] !== 'string' || typeof fields['textJson'] !== 'string') continue;
            const current = groqLexicalFirstText(fields['textJson']);
            if (current === null) continue;
            entries.push({
              id: candidate['id'],
              text: current.length > maxTextChars ? current.slice(0, maxTextChars) + '…' : current,
            });
          }
        }
      }
    }
  } catch {
    return [];
  }
  return entries;
}

export const GROQ_OP_JSON_SCHEMA = {
  name: 'paragraph_edits',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        maxItems: GROQ_MAX_OPS,
        items: {
          type: 'object',
          properties: {
            op: { const: 'set_paragraph_text' },
            blockId: { type: 'string' },
            text: { type: 'string', maxLength: GROQ_MAX_TEXT_CHARS },
          },
          required: ['op', 'blockId', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
};

export interface GroqUpstreamInput {
  instruction: string;
  inventory: GroqInventoryEntry[];
  model: string;
}

/** Chat-completions request with strict structured outputs. No secrets inside. */
export function buildGroqUpstreamRequest(input: GroqUpstreamInput): Record<string, unknown> {
  const system = [
    'You edit email copy via constrained operations. Rules:',
    '- Reply with ONLY set_paragraph_text operations for block IDs listed below.',
    '- Never invent block IDs, HTML, markdown, or structural changes.',
    '- text is plain text (no tags); keep each under 2000 characters.',
    '- Return {"operations": []} when no listed block matches the request.',
    `Editable paragraphs: ${JSON.stringify(input.inventory)}`,
  ].join('\n');
  return {
    model: input.model,
    temperature: 0,
    max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
    response_format: { type: 'json_schema', json_schema: GROQ_OP_JSON_SCHEMA },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input.instruction },
    ],
  };
}

export interface GroqValidatedOp {
  op: 'set_paragraph_text';
  blockId: string;
  text: string;
}

export type GroqMappedResponse =
  | { status: 200; body: { operations: GroqValidatedOp[]; dropped: string[]; model?: string } }
  | { status: number; body: { error: string; message: string; retryAfterMs?: number; retryable: boolean } };

function groqFailure(status: number, error: string, message: string, retryable: boolean): GroqMappedResponse {
  return { status, body: { error, message, retryable } };
}

/**
 * Map a Groq chat-completions response to validated operations.
 * Coarse gate only: unknown block IDs are dropped here, and the engine
 * re-validates everything before building a proposal.
 */
export function mapGroqUpstreamResponse(
  call: UpstreamCall,
  knownIds: string[],
  limits: { maxOps?: number; maxTextChars?: number } = {},
): GroqMappedResponse {
  const maxOps = limits.maxOps ?? GROQ_MAX_OPS;
  const maxTextChars = limits.maxTextChars ?? GROQ_MAX_TEXT_CHARS;
  const known = new Set(knownIds);
  if (call.status === 401) {
    return groqFailure(401, 'groq_unauthorized', 'Groq rejected the API key.', false);
  }
  if (call.status === 403) {
    return groqFailure(403, 'groq_forbidden', 'Groq refused the request (plan, credits, or permissions).', false);
  }
  if (call.status === 429) {
    const retryAfterMs = parseRetryAfter(call.headers);
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: 'Groq rate limit reached. Try again shortly.',
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }
  if (call.status === 400) {
    return groqFailure(400, 'invalid_request', upstreamMessage(safeJsonParse(call.bodyText), 'Groq rejected the request as invalid.'), false);
  }
  if (call.status === 408 || call.status === 504) {
    return groqFailure(502, 'upstream_timeout', 'Groq request timed out. Try again.', true);
  }
  if (call.status === 502 || call.status === 503) {
    return groqFailure(502, 'upstream_unavailable', 'Groq is temporarily unavailable. Try again.', true);
  }
  if (call.status !== 200) {
    const fallback = typeof call.status === 'number' ? `Groq error (HTTP ${call.status}).` : 'Groq error.';
    return groqFailure(502, 'upstream_error', upstreamMessage(safeJsonParse(call.bodyText), fallback), true);
  }
  const parsed = safeJsonParse(call.bodyText);
  const choices = isObject(parsed) && Array.isArray(parsed['choices']) ? (parsed['choices'] as unknown[]) : null;
  const message = choices && choices.length > 0 && isObject(choices[0])
    ? ((choices[0] as Record<string, unknown>)['message'] as unknown)
    : null;
  const content = isObject(message) ? message['content'] : null;
  let operations: unknown = null;
  try {
    const decoded = typeof content === 'string' ? (JSON.parse(content) as unknown) : content;
    if (isObject(decoded) && Array.isArray(decoded['operations'])) {
      operations = decoded['operations'] as unknown[];
    }
  } catch {
    operations = null;
  }
  if (!Array.isArray(operations)) {
    return groqFailure(502, 'invalid_response', 'Groq returned an unusable response. Nothing was changed.', false);
  }
  const valid: GroqValidatedOp[] = [];
  const dropped: string[] = [];
  for (const entry of (operations as unknown[]).slice(0, maxOps)) {
    if (!isObject(entry) || entry['op'] !== 'set_paragraph_text') {
      dropped.push('Dropped an unsupported operation.');
      continue;
    }
    if (typeof entry['blockId'] !== 'string' || !known.has(entry['blockId'])) {
      dropped.push('Dropped an operation for an unknown block.');
      continue;
    }
    if (typeof entry['text'] !== 'string' || !entry['text'].trim()) {
      dropped.push('Dropped an operation with empty text.');
      continue;
    }
    if (entry['text'].length > maxTextChars) {
      dropped.push('Dropped an operation with oversized text.');
      continue;
    }
    valid.push({ op: 'set_paragraph_text', blockId: entry['blockId'], text: entry['text'] });
  }
  if ((operations as unknown[]).length > maxOps) {
    dropped.push(`Ignored ${(operations as unknown[]).length - maxOps} operation(s) beyond the ${maxOps}-operation cap.`);
  }
  if (valid.length === 0 && (operations as unknown[]).length > 0) {
    return groqFailure(502, 'invalid_response', dropped[0] ?? 'Groq returned no usable editing operations.', false);
  }
  const modelName = isObject(parsed) && typeof parsed['model'] === 'string' ? (parsed['model'] as string) : undefined;
  return {
    status: 200,
    body: {
      operations: valid,
      dropped,
      ...(modelName ? { model: modelName } : {}),
    },
  };
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

async function handleGroqGenerate(req: IncomingMessage, res: ServerResponse, config: ServerConfig): Promise<void> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    sendJson(res, 400, { error: 'invalid_request', message: 'Content-Type must be application/json.' });
    return;
  }
  const raw = await readBody(req, config.maxBodyBytes);
  if (!raw.ok) {
    log('groq.generate.rejected', { reason: 'body_too_large' });
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
    log('groq.generate.rejected', { reason: validated.failure.error });
    sendJson(res, validated.failure.status, { error: validated.failure.error, message: validated.failure.message });
    return;
  }
  if (validated.value.mode !== 'edit') {
    log('groq.generate.rejected', { reason: 'mode_not_supported' });
    sendJson(res, 400, { error: 'invalid_request', message: 'Groq provider currently supports editing existing designs only.' });
    return;
  }
  if (!config.groqApiKey) {
    sendJson(res, 501, { error: 'groq_not_configured', message: 'GROQ_API_KEY is not set. See docs/BYOM_GROQ.md.' });
    return;
  }
  const inventory = buildGroqInventory(validated.value.baseDesign);
  if (inventory.length === 0) {
    sendJson(res, 400, { error: 'invalid_request', message: 'No editable paragraph blocks found in the current design.' });
    return;
  }
  const started = Date.now();
  log('groq.generate.start', { model: config.groqModel, promptChars: validated.value.instruction.length, blocks: inventory.length });
  const fetchImpl = config.fetchImpl ?? fetch;
  let upstreamStatus = 0;
  try {
    const upstreamRes = await fetchImpl(config.groqUpstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify(buildGroqUpstreamRequest({
        instruction: validated.value.instruction,
        inventory,
        model: config.groqModel,
      })),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    upstreamStatus = upstreamRes.status;
    const headers: Record<string, string> = {};
    upstreamRes.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const bodyText = await upstreamRes.text();
    const mapped = mapGroqUpstreamResponse(
      { status: upstreamRes.status, headers, bodyText },
      inventory.map((entry) => entry.id),
    );
    log('groq.generate.done', { upstreamStatus, mappedStatus: mapped.status, ms: Date.now() - started });
    sendJson(res, mapped.status, { ...mapped.body });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    log('groq.generate.failed', { reason: timedOut ? 'timeout' : 'network', upstreamStatus });
    sendJson(
      res,
      502,
      timedOut
        ? { error: 'upstream_timeout', message: 'Groq request timed out. Try again.', retryable: true }
        : { error: 'upstream_unreachable', message: 'Could not reach Groq. Try again.', retryable: true },
    );
  }
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
  if (req.method === 'GET' && url.pathname === '/api/ai/groq-status') {
    log('groq.status', { configured: config.groqApiKey !== '' });
    sendJson(res, 200, { configured: config.groqApiKey !== '', model: config.groqModel });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/groq-generate') {
    await handleGroqGenerate(req, res, config);
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
    log('listening', { port: config.port, configured: config.apiKey !== '', groqConfigured: config.groqApiKey !== '', auth: redactAuthHeader(config.apiKey ? `Bearer ${config.apiKey}` : undefined) });
  });
  return server;
}

const invokedAsMain = typeof process.argv[1] === 'string' && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsMain) {
  startServer();
}
