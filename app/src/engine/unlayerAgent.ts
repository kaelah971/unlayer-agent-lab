/**
 * Typed adapter over Unlayer's global agent API (`unlayer.agent`).
 *
 * M1 is a behavior-preserving refactor: every function below maps 1:1 to a
 * native promise-based agent method with no added timeouts, retries,
 * hashing, persistence, or state. Timeouts that exist are Unlayer's own
 * (15 s by default, 60 s for getDesign/loadDesign/exportHtml per the
 * official AI Agents documentation).
 *
 * - React-free on purpose: this module never imports `react`, so the future
 *   Developer Lab, AI Studio, and unit tests can share it.
 * - `describe()` stays the connection probe. Per official docs, the
 *   `unlayer.agent` object exists even when no builder offers the API, so
 *   presence of the object proves nothing — callers must call `describe()`
 *   and treat failure as "no agent-enabled editors".
 * - `loadDesign()` is the validating loader: on `{ ok: false }` nothing on
 *   the canvas changed. The full native result (error `path`/`message`/
 *   `code`, `protectedElements`, `audit`) is returned untouched — callers
 *   decide what to surface.
 *
 * Global access intentionally mirrors the previous App.tsx pattern
 * (`(unlayer as unknown as { agent?: AgentApi }).agent`, throwing
 * `Error('Agent API unavailable')` when absent), so runtime behavior —
 * including the ReferenceError path if the builder script never defined
 * the global — is unchanged.
 */
import type {
  AgentApi,
  AgentDescription,
  AgentLoadDesignResult,
  JSONTemplate,
} from './types';

function getAgent(): AgentApi {
  const agent = (unlayer as unknown as { agent?: AgentApi }).agent;
  if (!agent) {
    throw new Error('Agent API unavailable');
  }
  return agent;
}

/** Instructions plus this builder's capabilities. Call this first. */
export function describeAgent(): Promise<AgentDescription> {
  return getAgent().describe();
}

/** Reads the current design JSON from the open builder. */
export function getAgentDesign(): Promise<JSONTemplate> {
  return getAgent().getDesign();
}

/**
 * Full JSON Schema of the design this editor accepts. Present in the
 * installed SDK types (`AgentApi.schema`), but older pinned builders may
 * not implement it — that case throws a plain, displayable error instead
 * of failing with `undefined is not a function`.
 */
export function getAgentSchema(): Promise<unknown> {
  const schemaFn = (getAgent() as Partial<Pick<AgentApi, 'schema'>>).schema;
  if (typeof schemaFn !== 'function') {
    throw new Error('Agent schema API is not supported by this builder.');
  }
  return (schemaFn as () => Promise<unknown>)();
}

/**
 * Validates, then loads. Resolves with the full native result; on
 * `{ ok: false, loaded: false }` nothing changed — inspect `errors` and
 * retry with a fixed design.
 */
export function loadAgentDesign(design: JSONTemplate): Promise<AgentLoadDesignResult> {
  return getAgent().loadDesign(design);
}
