/**
 * Deterministic paragraph-edit proposal logic (M2 safety foundation).
 *
 * Pure TypeScript: no React, no DOM, no Unlayer global. All functions here
 * are directly unit-testable under Vitest in Node mode.
 *
 * Two responsibilities:
 * 1. `prepareParagraphEdit` — build a before/after proposal from a design
 *    snapshot without touching the canvas or the original object.
 * 2. `approveEdit` — decide the outcome of applying a proposal against the
 *    live design (fresh / stale / rejected / skipped) via an injected port,
 *    so tests use a mock and production passes the real agent adapter.
 *
 * M2 scope notes:
 * - The first-block-only paragraph transform is preserved as-is (manual-test
 *   scope). General multi-block editing is M4+ work.
 * - Staleness is still `JSON.stringify` equality, exactly as the app behaved
 *   in M1. A canonical hash replaces this in a later milestone.
 */
import type { JSONTemplate } from './types';

/** Narrow structural view of the design subtree this transform touches. */
interface ParagraphDesign {
  body?: {
    rows?: Array<{
      columns?: Array<{
        contents?: Array<{
          type?: string;
          values?: {
            textJson?: string;
            text?: string;
            locked?: boolean;
          };
        }>;
      }>;
    }>;
  };
}

interface LexicalText {
  root?: {
    children?: Array<{
      children?: Array<{ text?: string }>;
    }>;
  };
}

/** A prepared, unapplied edit. The canvas is unchanged until approval. */
export interface PreparedParagraphEdit {
  before: string;
  after: string;
  /** `JSON.stringify` snapshot of the design the proposal was based on. */
  baseDesign: string;
  candidateDesign: JSONTemplate;
}

/**
 * Escape plain text for interpolation into an HTML string.
 * `&` first so existing entities are not double-processed.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a paragraph-replacement proposal from a design snapshot.
 *
 * Throws `Error('Enter replacement text first.')` for empty input,
 * `Error('First content block is not an editable paragraph.')` for missing,
 * unsupported, or locked blocks, and
 * `Error('Paragraph text structure could not be safely updated.')` when the
 * rich-text JSON does not contain the expected text node.
 *
 * Safety properties (covered by tests):
 * - The input `original` is never mutated (`structuredClone` first).
 * - `values.textJson` (Lexical JSON) receives the raw replacement text;
 *   `JSON.stringify` performs the JSON-level escaping.
 * - `values.text` (HTML) receives the HTML-escaped replacement text via a
 *   replacer function, so `$`-patterns (`$&`, `$'`, …) in user input are
 *   inserted literally instead of being interpreted by `String.replace`.
 */
export function prepareParagraphEdit(
  original: unknown,
  replacementText: string,
): PreparedParagraphEdit {
  // Fail closed on non-object input (e.g. a null snapshot): the optional
  // chain below would otherwise throw a bare TypeError on `.body`.
  const candidate =
    original !== null && typeof original === 'object'
      ? (structuredClone(original) as ParagraphDesign)
      : ({} as ParagraphDesign);

  const paragraph = candidate.body?.rows?.[0]?.columns?.[0]?.contents?.[0];

  if (
    paragraph?.type !== 'paragraph' ||
    paragraph.values?.locked ||
    typeof paragraph.values?.textJson !== 'string' ||
    typeof paragraph.values?.text !== 'string'
  ) {
    throw new Error('First content block is not an editable paragraph.');
  }

  const richText = JSON.parse(paragraph.values.textJson) as LexicalText;

  const textNode = richText.root?.children?.[0]?.children?.[0];
  const before = textNode?.text;
  const after = replacementText.trim();

  if (!after) {
    throw new Error('Enter replacement text first.');
  }

  if (!before || !textNode || !paragraph.values.text.includes(before)) {
    throw new Error('Paragraph text structure could not be safely updated.');
  }

  textNode.text = after;
  paragraph.values.textJson = JSON.stringify(richText);
  paragraph.values.text = paragraph.values.text.replace(before, () => escapeHtml(after));

  return {
    before,
    after,
    baseDesign: JSON.stringify(original),
    candidateDesign: candidate as unknown as JSONTemplate,
  };
}

/** `true` when the live design no longer matches the proposal base. */
export function isDesignChanged(current: unknown, baseDesign: string): boolean {
  return JSON.stringify(current) !== baseDesign;
}

/** Minimal agent surface the approval decision needs. */
export interface AgentPort {
  getDesign: () => Promise<unknown>;
  loadDesign: (design: JSONTemplate) => Promise<{
    ok: boolean;
    loaded: boolean;
    errors?: Array<{ message: string }>;
  }>;
}

export type ApproveOutcome =
  | { status: 'applied' }
  | { status: 'stale' }
  | { status: 'rejected'; message: string }
  | { status: 'skipped'; reason: 'no-proposal' | 'already-applying' };

/**
 * Apply a prepared proposal.
 *
 * Mirrors the M1 approval algorithm exactly:
 * 1. No proposal or an approval already in flight → `skipped` (no I/O).
 * 2. Re-read the live design; mismatch with the base → `stale` (no I/O
 *    beyond the re-read, proposal must be discarded by the caller).
 * 3. Persist the pre-apply backup, then `loadDesign`.
 * 4. `!ok || !loaded` → `rejected` with the joined native error messages.
 * 5. Otherwise → `applied`.
 *
 * Errors from the port (e.g. unavailable agent API) propagate to the
 * caller; nothing is backed up or loaded in that case.
 */
export async function approveEdit(
  port: AgentPort,
  proposal: PreparedParagraphEdit | null,
  options: {
    alreadyApplying: boolean;
    backup: (baseDesign: string) => void;
    /** Called after the backup write, right before `loadDesign`. */
    onApplying?: () => void;
  },
): Promise<ApproveOutcome> {
  if (!proposal) {
    return { status: 'skipped', reason: 'no-proposal' };
  }
  if (options.alreadyApplying) {
    return { status: 'skipped', reason: 'already-applying' };
  }

  const current = await port.getDesign();

  if (isDesignChanged(current, proposal.baseDesign)) {
    return { status: 'stale' };
  }

  options.backup(proposal.baseDesign);
  options.onApplying?.();

  const result = await port.loadDesign(proposal.candidateDesign);

  if (!result.ok || !result.loaded) {
    const explanation = result.errors?.map((error) => error.message).join('; ');
    return {
      status: 'rejected',
      message: explanation || 'Unlayer rejected the proposed design.',
    };
  }

  return { status: 'applied' };
}
