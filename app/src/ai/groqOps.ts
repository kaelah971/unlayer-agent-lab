/**
 * BYOM operation engine (M8, Groq first).
 *
 * A constrained alternative to full-design generation: the model returns
 * small editing OPERATIONS against known block IDs — never arbitrary
 * Unlayer design JSON. Every operation is validated here (whitelisted op
 * type, block ID present in the live design, plain-text payload within
 * size caps) and applied through the same escaping rules as manual edits
 * (`escapeHtml` + Lexical `textJson` consistency). The result travels the
 * unchanged pipeline: diff → policies → ChangeInspector → policy gate →
 * stale check → human approval → `agent.loadDesign`.
 *
 * v1 scope: `set_paragraph_text` on existing, unlocked paragraph blocks.
 * No HTML injection (payloads are plain text, HTML-escaped on apply), no
 * structural changes, no new blocks, no deletions.
 */
import { diffDesigns } from '../engine/designDiff';
import {
  DEFAULT_POLICY_CONFIG,
  evaluatePolicies,
  type PolicyConfig,
} from '../engine/policies';
import { escapeHtml, isDesignChanged, type PreparedParagraphEdit } from '../engine/proposals';
import type { JSONTemplate } from '../engine/types';

export const GROQ_SUPPORTED_OP = 'set_paragraph_text' as const;
export const GROQ_MAX_OPS = 10;
export const GROQ_MAX_TEXT_CHARS = 2000;
export const GROQ_MAX_INVENTORY_BLOCKS = 20;
export const GROQ_MAX_INVENTORY_TEXT_CHARS = 300;

export interface GroqParagraphOp {
  op: typeof GROQ_SUPPORTED_OP;
  blockId: string;
  text: string;
}

export interface ParagraphInventoryEntry {
  id: string;
  /** Current plain text (Lexical first text node), truncated for prompts. */
  text: string;
}

interface ContentBlock {
  id?: unknown;
  type?: unknown;
  values?: {
    text?: unknown;
    textJson?: string;
    locked?: unknown;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eachContentBlock(design: unknown, visit: (block: ContentBlock, path: string) => void): void {
  if (!isObject(design)) return;
  const body = design['body'];
  if (!isObject(body)) return;
  const sections: Array<{ rows: unknown; prefix: string }> = [{ rows: body['rows'], prefix: 'body.rows' }];
  if (body['headers'] !== undefined) sections.push({ rows: body['headers'], prefix: 'body.headers' });
  if (body['footers'] !== undefined) sections.push({ rows: body['footers'], prefix: 'body.footers' });
  for (const section of sections) {
    if (!Array.isArray(section.rows)) continue;
    section.rows.forEach((row, rowIndex) => {
      if (!isObject(row) || !Array.isArray(row['columns'])) return;
      (row['columns'] as unknown[]).forEach((column, columnIndex) => {
        if (!isObject(column) || !Array.isArray(column['contents'])) return;
        (column['contents'] as unknown[]).forEach((block, blockIndex) => {
          if (!isObject(block)) return;
          visit(block as ContentBlock, `${section.prefix}[${rowIndex}].columns[${columnIndex}].contents[${blockIndex}]`);
        });
      });
    });
  }
}

function lexicalFirstText(textJson: string): string | null {
  try {
    const parsed = JSON.parse(textJson) as unknown;
    if (!isObject(parsed)) return null;
    const root = parsed['root'];
    if (!isObject(root) || !Array.isArray(root['children'])) return null;
    const first = root['children'][0];
    if (!isObject(first) || !Array.isArray(first['children'])) return null;
    const node = first['children'][0];
    if (!isObject(node) || typeof node['text'] !== 'string') return null;
    return node['text'];
  } catch {
    return null;
  }
}

/**
 * Editable paragraph inventory: unlocked paragraphs whose Lexical text can
 * be read AND safely rewritten. Blocks that fail the editability check are
 * excluded so the model never targets them. Never throws; uninspectable
 * input yields an empty inventory.
 */
export function buildParagraphInventory(
  design: unknown,
  limits: { maxBlocks?: number; maxTextChars?: number } = {},
): ParagraphInventoryEntry[] {
  const maxBlocks = limits.maxBlocks ?? GROQ_MAX_INVENTORY_BLOCKS;
  const maxTextChars = limits.maxTextChars ?? GROQ_MAX_INVENTORY_TEXT_CHARS;
  const entries: ParagraphInventoryEntry[] = [];
  try {
    eachContentBlock(design, (block) => {
      if (entries.length >= maxBlocks) return;
      if (typeof block.id !== 'string' || !block.id) return;
      if (block.type !== 'paragraph' || block.values?.locked) return;
      if (typeof block.values?.text !== 'string' || typeof block.values?.textJson !== 'string') return;
      const current = lexicalFirstText(block.values.textJson);
      if (current === null) return;
      entries.push({
        id: block.id,
        text: current.length > maxTextChars ? current.slice(0, maxTextChars) + '…' : current,
      });
    });
  } catch {
    return [];
  }
  return entries;
}

export interface ValidatedOperations {
  valid: GroqParagraphOp[];
  /** Human-readable reasons entries were dropped (logged, never applied). */
  dropped: string[];
}

/**
 * Validate raw model output against the inventory. Unknown op types,
 * unknown block IDs, empty/oversized text, and malformed entries are
 * dropped — never repaired, never applied. Pure; never throws.
 */
export function validateGroqOperations(
  raw: unknown,
  inventory: ParagraphInventoryEntry[],
  limits: { maxOps?: number; maxTextChars?: number } = {},
): ValidatedOperations {
  const maxOps = limits.maxOps ?? GROQ_MAX_OPS;
  const maxTextChars = limits.maxTextChars ?? GROQ_MAX_TEXT_CHARS;
  const ids = new Set(inventory.map((entry) => entry.id));
  const valid: GroqParagraphOp[] = [];
  const dropped: string[] = [];
  const list = isObject(raw) && Array.isArray((raw as { operations?: unknown }).operations)
    ? ((raw as { operations: unknown[] }).operations as unknown[])
    : null;
  if (!list) {
    return { valid, dropped: ['Model output did not contain an operations array.'] };
  }
  for (const entry of list.slice(0, maxOps)) {
    if (!isObject(entry)) {
      dropped.push('Dropped a malformed operation (not an object).');
      continue;
    }
    if (entry['op'] !== GROQ_SUPPORTED_OP) {
      dropped.push(`Dropped unsupported operation type ${JSON.stringify(entry['op'] ?? null)}.`);
      continue;
    }
    if (typeof entry['blockId'] !== 'string' || !ids.has(entry['blockId'])) {
      dropped.push(`Dropped operation for unknown block ${JSON.stringify(entry['blockId'] ?? null)}.`);
      continue;
    }
    if (typeof entry['text'] !== 'string' || !entry['text'].trim()) {
      dropped.push(`Dropped empty replacement text for block ${JSON.stringify(entry['blockId'])}.`);
      continue;
    }
    if (entry['text'].length > maxTextChars) {
      dropped.push(`Dropped oversized replacement text for block ${JSON.stringify(entry['blockId'])}.`);
      continue;
    }
    valid.push({ op: GROQ_SUPPORTED_OP, blockId: entry['blockId'], text: entry['text'] });
  }
  if (list.length > maxOps) {
    dropped.push(`Ignored ${list.length - maxOps} operation(s) beyond the ${maxOps}-operation cap.`);
  }
  return { valid, dropped };
}

function findEditableBlock(candidate: unknown, blockId: string): { block: ContentBlock; parsed: Record<string, unknown>; textNode: { text?: string }; before: string; htmlText: string } {
  const matches: ContentBlock[] = [];
  eachContentBlock(candidate, (block) => {
    if (block.id === blockId) matches.push(block);
  });
  if (matches.length !== 1) {
    throw new Error(`Block "${blockId}" is not uniquely addressable in the current design.`);
  }
  const block = matches[0];
  if (block.type !== 'paragraph' || block.values?.locked) {
    throw new Error(`Block "${blockId}" is not an editable paragraph.`);
  }
  if (typeof block.values?.text !== 'string' || typeof block.values?.textJson !== 'string') {
    throw new Error(`Block "${blockId}" has no editable text fields.`);
  }
  let richText: unknown;
  try {
    richText = JSON.parse(block.values.textJson) as unknown;
  } catch {
    throw new Error(`Block "${blockId}" text structure could not be safely updated.`);
  }
  if (!isObject(richText)) throw new Error(`Block "${blockId}" text structure could not be safely updated.`);
  const root = richText['root'];
  if (!isObject(root) || !Array.isArray(root['children'])) {
    throw new Error(`Block "${blockId}" text structure could not be safely updated.`);
  }
  const first = root['children'][0];
  if (!isObject(first) || !Array.isArray(first['children'])) {
    throw new Error(`Block "${blockId}" text structure could not be safely updated.`);
  }
  const textNode = first['children'][0];
  if (!isObject(textNode) || typeof textNode['text'] !== 'string') {
    throw new Error(`Block "${blockId}" text structure could not be safely updated.`);
  }
  return { block, parsed: richText as Record<string, unknown>, textNode: textNode as { text?: string }, before: textNode['text'] as string, htmlText: block.values.text };
}

/**
 * Apply validated operations to a design snapshot. Returns the candidate
 * design; the input is never mutated. Throws fail-closed on any
 * unaddressable, locked, or structurally unsafe block — nothing is
 * partially applied (the throw happens before the result is used, and the
 * input clone is discarded with it).
 *
 * Escaping mirrors `prepareParagraphEdit`: raw text into Lexical JSON,
 * HTML-escaped text into `values.text` via a replacer function (so
 * `$`-patterns land literally), tolerating Unlayer's post-load
 * normalization (raw or escaped match, raw preferred).
 */
export function applyParagraphOps(original: unknown, operations: GroqParagraphOp[]): JSONTemplate {
  if (!isObject(original)) {
    throw new Error('Current design is unavailable; Groq operations cannot be applied.');
  }
  const candidate = structuredClone(original) as unknown;
  for (const operation of operations) {
    const located = findEditableBlock(candidate, operation.blockId);
    const after = operation.text.trim();
    if (!after) throw new Error(`Block "${operation.blockId}" replacement text is empty.`);
    const { textNode, before, htmlText } = located;
    let match: string | null = null;
    if (before) {
      if (htmlText.includes(before)) match = before;
      else {
        const escaped = escapeHtml(before);
        if (htmlText.includes(escaped)) match = escaped;
      }
    }
    if (!before || !match) {
      throw new Error(`Block "${operation.blockId}" text structure could not be safely updated.`);
    }
    textNode.text = after;
    const values = located.block.values as { text: string; textJson: string };
    values.textJson = JSON.stringify(located.parsed);
    values.text = htmlText.replace(match, () => escapeHtml(after));
  }
  return candidate as JSONTemplate;
}

export type GroqProposalOutcome =
  | { status: 'ready'; proposal: PreparedParagraphEdit }
  | { status: 'no-change' };

/**
 * Build a reviewable proposal from validated operations. Fail-closed:
 * unusable designs, unsafe application, and incomplete diffs throw;
 * zero-change results report `no-change`.
 */
export function prepareGroqProposal(input: {
  original: unknown;
  operations: GroqParagraphOp[];
  instruction: string;
  policyConfig?: PolicyConfig;
}): GroqProposalOutcome {
  const instruction = input.instruction.trim();
  if (!instruction) {
    throw new Error('Enter an AI instruction first.');
  }
  if (!isObject(input.original)) {
    throw new Error('Current design is unavailable; Groq proposal cannot be based on it.');
  }
  if (input.operations.length === 0) {
    return { status: 'no-change' };
  }
  const candidateDesign = applyParagraphOps(input.original, input.operations);
  const diff = diffDesigns(input.original, candidateDesign);
  if (!diff.complete) {
    throw new Error(
      `Groq edit could not be safely compared: ${diff.limitations[0] ?? 'unsupported structure'}. Your canvas was not changed.`,
    );
  }
  if (diff.changes.length === 0) {
    return { status: 'no-change' };
  }
  const config = input.policyConfig ?? DEFAULT_POLICY_CONFIG;
  const evaluation = evaluatePolicies({ candidate: candidateDesign, original: input.original, config });
  return {
    status: 'ready',
    proposal: {
      before: 'Current design',
      after: instruction.length > 200 ? instruction.slice(0, 200) + '…' : instruction,
      baseDesign: JSON.stringify(input.original),
      candidateDesign,
      diff,
      policies: evaluation.results,
      policyBlocked: evaluation.blocked,
      source: { kind: 'ai', mode: 'edit', instruction },
    },
  };
}

export type GroqFinalOutcome =
  | { status: 'ready'; proposal: PreparedParagraphEdit }
  | { status: 'stale' }
  | { status: 'no-change' }
  | { status: 'provider-error'; code: string; message: string; retryable: boolean };

export interface GroqOperationsResult {
  status: 'ready';
  operations: unknown;
  dropped?: string[];
  model?: string;
}

export type GroqGenerationResult =
  | GroqOperationsResult
  | { status: 'no-change' }
  | { status: 'not-configured' }
  | { status: 'error'; code: string; message: string; retryable: boolean };

/**
 * Resolve one Groq turn into a UI outcome. Mirrors `finalizeAiGeneration`:
 * stale re-check against the live canvas, then validation + application
 * through the same fail-closed path. Provider errors pass through
 * untouched; invalid operations become a `provider-error` (never a
 * proposal, never a canvas write).
 */
export function finalizeGroqGeneration(input: {
  result: GroqGenerationResult;
  baseSnapshot: string;
  liveDesign: unknown;
  instruction: string;
  policyConfig?: PolicyConfig;
}): GroqFinalOutcome {
  if (input.result.status === 'not-configured') {
    return {
      status: 'provider-error',
      code: 'not-configured',
      message: 'Groq is not configured. Start the local AI server with a GROQ_API_KEY — see docs/BYOM_GROQ.md. Manual editing still works.',
      retryable: false,
    };
  }
  if (input.result.status === 'no-change') {
    return { status: 'no-change' };
  }
  if (input.result.status === 'error') {
    return {
      status: 'provider-error',
      code: input.result.code,
      message: input.result.message,
      retryable: input.result.retryable,
    };
  }
  if (isDesignChanged(input.liveDesign, input.baseSnapshot)) {
    return { status: 'stale' };
  }
  const original = JSON.parse(input.baseSnapshot) as unknown;
  const inventory = buildParagraphInventory(original);
  const { valid, dropped } = validateGroqOperations(input.result.operations, inventory);
  if (valid.length === 0) {
    return {
      status: 'provider-error',
      code: 'invalid_response',
      message: dropped[0] ?? 'Groq returned no usable editing operations. Your canvas was not changed.',
      retryable: false,
    };
  }
  try {
    const prepared = prepareGroqProposal({
      original,
      operations: valid,
      instruction: input.instruction,
      policyConfig: input.policyConfig,
    });
    if (prepared.status === 'no-change') return { status: 'no-change' };
    return { status: 'ready', proposal: prepared.proposal };
  } catch (error) {
    return {
      status: 'provider-error',
      code: 'invalid_response',
      message: error instanceof Error ? error.message : 'Groq proposal could not be prepared.',
      retryable: false,
    };
  }
}
