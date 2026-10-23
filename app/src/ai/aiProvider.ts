/**
 * AI provider client (M5).
 *
 * Same-origin calls to the local AI backend (`/api/ai/generate`,
 * `/api/ai/status`). The browser NEVER sees Unlayer credentials: no API
 * keys, tokens, or Authorization headers exist anywhere in this module.
 * All Unlayer traffic happens server-side (see `app/server/ai-server.ts`).
 *
 * Pure fetch logic with injected `fetch` for tests. No React.
 */
import type { JSONTemplate } from '../engine/types';

export type AiMode = 'create' | 'edit';

export interface AiGenerateInput {
  instruction: string;
  mode: AiMode;
  baseDesign: unknown;
}

export type AiGenerateResult =
  | { status: 'ready'; design: unknown; model?: string; creditsUsed?: number }
  | { status: 'no-change' }
  | { status: 'not-configured' }
  | { status: 'error'; code: string; message: string; retryable: boolean; retryAfterMs?: number };

export const AI_ENDPOINT = '/api/ai/generate';
export const AI_STATUS_ENDPOINT = '/api/ai/status';
export const AI_TIMEOUT_MS = 120_000;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_DESIGN_JSON_BYTES = 4 * 1024 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Throws a displayable Error for invalid input (programmer/user error).
 * Everything asynchronous is returned as an `AiGenerateResult`.
 */
export function validateAiInput(input: AiGenerateInput): { instruction: string; designJson: string } {
  if (input.mode !== 'create' && input.mode !== 'edit') {
    throw new Error('Unknown generation mode.');
  }
  const instruction = input.instruction.trim();
  if (!instruction) {
    throw new Error('Enter an AI instruction first.');
  }
  if (instruction.length > MAX_PROMPT_CHARS) {
    throw new Error(`AI instruction is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  let designJson: string;
  try {
    designJson = JSON.stringify(input.baseDesign);
  } catch {
    throw new Error('Current design could not be serialized for the AI request.');
  }
  if (typeof designJson !== 'string' || byteLength(designJson) > MAX_DESIGN_JSON_BYTES) {
    throw new Error('Current design is too large to send to AI.');
  }
  return { instruction, designJson };
}

function serverMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message: unknown }).message === 'string') {
    return (body as { message: string }).message;
  }
  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCodeForStatus(status: number, body: unknown): string {
  if (isObject(body) && typeof body['error'] === 'string') {
    const code = body['error'];
    if (code === 'ai_not_configured') return 'not-configured';
    // Normalize server auth codes to client-facing names.
    if (code === 'ai_unauthorized') return 'unauthorized';
    if (code === 'ai_forbidden') return 'forbidden';
    if (['rate_limited', 'invalid_request', 'payload_too_large', 'upstream_timeout', 'upstream_unavailable', 'upstream_error', 'invalid_response'].includes(code)) {
      return code;
    }
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413) return 'invalid_request';
  return 'upstream_error';
}

function isValidDesign(value: unknown): value is JSONTemplate {
  return typeof value === 'object' && value !== null && typeof (value as { body?: unknown }).body === 'object' && (value as { body: unknown }).body !== null;
}

export async function requestAiGeneration(
  input: AiGenerateInput,
  options?: {
    fetchFn?: typeof fetch;
    endpoint?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<AiGenerateResult> {
  const { instruction, designJson } = validateAiInput(input);
  const fetchFn = options?.fetchFn ?? fetch;
  const endpoint = options?.endpoint ?? AI_ENDPOINT;
  const timeoutMs = options?.timeoutMs ?? AI_TIMEOUT_MS;

  if (options?.signal?.aborted) {
    return { status: 'error', code: 'cancelled', message: 'AI request cancelled.', retryable: false };
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onExternalAbort = (): void => timeout.abort();
  options?.signal?.addEventListener('abort', onExternalAbort);
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, mode: input.mode, baseDesign: JSON.parse(designJson) as unknown }),
      signal: timeout.signal,
    });
  } catch (error) {
    if (options?.signal?.aborted) {
      return { status: 'error', code: 'cancelled', message: 'AI request cancelled.', retryable: false };
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { status: 'error', code: 'timeout', message: 'AI request timed out. Try again.', retryable: true };
    }
    return { status: 'error', code: 'network', message: 'AI backend is unreachable. Start the local AI server and try again.', retryable: true };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }

  if (response.status === 304) {
    return { status: 'no-change' };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const design = typeof body === 'object' && body !== null ? (body as { design?: unknown }).design : undefined;
    if (!isValidDesign(design)) {
      return { status: 'error', code: 'invalid_response', message: 'AI returned an unusable design. Nothing was changed.', retryable: false };
    }
    const meta = body as { model?: unknown; creditsUsed?: unknown };
    return {
      status: 'ready',
      design,
      model: typeof meta.model === 'string' ? meta.model : undefined,
      creditsUsed: typeof meta.creditsUsed === 'number' ? meta.creditsUsed : undefined,
    };
  }

  const code = errorCodeForStatus(response.status, body);
  if (code === 'not-configured') {
    return { status: 'not-configured' };
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    message?: unknown;
    retryAfterMs?: unknown;
    retryable?: unknown;
  };
  return {
    status: 'error',
    code,
    message: serverMessage(body, `AI request failed (HTTP ${response.status}).`),
    retryable:
      typeof record.retryable === 'boolean'
        ? record.retryable
        : response.status === 429 || response.status >= 500,
    ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
  };
}

export async function checkAiStatus(
  fetchFn: typeof fetch = fetch,
  endpoint: string = AI_STATUS_ENDPOINT,
): Promise<boolean> {
  try {
    const response = await fetchFn(endpoint);
    if (!response.ok) return false;
    const body = (await response.json()) as unknown;
    return typeof body === 'object' && body !== null && (body as { configured?: unknown }).configured === true;
  } catch {
    return false;
  }
}
