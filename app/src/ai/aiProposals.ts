/**
 * AI proposal assembly (M5).
 *
 * Turns an AI-generated design into the same proposal shape the manual
 * flow uses, so generation results flow through the unchanged ChangeInspector,
 * policy gate, stale check, approval, and native result display.
 *
 * Nothing here touches the canvas or calls Unlayer: preparation only reads.
 * `loadDesign` happens exclusively in `approveEdit`, after human approval.
 */
import { diffDesigns } from '../engine/designDiff';
import {
  DEFAULT_POLICY_CONFIG,
  evaluatePolicies,
  type PolicyConfig,
} from '../engine/policies';
import { isDesignChanged, type PreparedParagraphEdit } from '../engine/proposals';
import type { JSONTemplate } from '../engine/types';
import type { AiGenerateResult, AiMode } from './aiProvider';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value;
}

export type AiProposalOutcome =
  | { status: 'ready'; proposal: PreparedParagraphEdit }
  | { status: 'no-change' };

/**
 * Build a reviewable proposal from an AI-generated design.
 *
 * Fail-closed: throws when the candidate is not a usable email design, or
 * when the structural diff is incomplete (unsupported/ambiguous output is
 * never presented as a clean proposal). Returns `no-change` when the AI
 * output matches the base design.
 */
export function prepareAiProposal(input: {
  original: unknown;
  candidate: unknown;
  instruction: string;
  mode: AiMode;
  policyConfig?: PolicyConfig;
}): AiProposalOutcome {
  const instruction = input.instruction.trim();
  if (!instruction) {
    throw new Error('Enter an AI instruction first.');
  }
  if (input.mode !== 'create' && input.mode !== 'edit') {
    throw new Error('Unknown generation mode.');
  }
  if (!isObject(input.original)) {
    throw new Error('Current design is unavailable; AI proposal cannot be based on it.');
  }
  if (!isObject(input.candidate) || !isObject(input.candidate['body'])) {
    throw new Error('AI returned an unusable design (missing email body). Your canvas was not changed.');
  }
  const candidateDesign = input.candidate as JSONTemplate;
  const diff = diffDesigns(input.original, candidateDesign);
  if (!diff.complete) {
    throw new Error(
      `AI design could not be safely compared: ${diff.limitations[0] ?? 'unsupported structure'}. Your canvas was not changed.`,
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
      after: truncate(instruction, 200),
      baseDesign: JSON.stringify(input.original),
      candidateDesign,
      diff,
      policies: evaluation.results,
      policyBlocked: evaluation.blocked,
      source: { kind: 'ai', mode: input.mode, instruction },
    },
  };
}

export type AiFinalOutcome =
  | { status: 'ready'; proposal: PreparedParagraphEdit }
  | { status: 'stale' }
  | { status: 'no-change' }
  | { status: 'provider-error'; code: string; message: string; retryable: boolean };

/**
 * Resolve one AI turn into a UI outcome. `baseSnapshot` is the design JSON
 * captured BEFORE the network request; `liveDesign` is re-read AFTER the
 * response, so canvas edits made while AI was generating are detected and
 * the generated design is discarded instead of silently replacing them.
 */
export function finalizeAiGeneration(input: {
  result: AiGenerateResult;
  baseSnapshot: string;
  liveDesign: unknown;
  instruction: string;
  mode: AiMode;
  policyConfig?: PolicyConfig;
}): AiFinalOutcome {
  if (input.result.status === 'not-configured') {
    return {
      status: 'provider-error',
      code: 'not-configured',
      message: 'AI is not configured. Start the local AI server with an Unlayer API key — see docs/AI_STUDIO.md. Manual editing still works.',
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
  // baseSnapshot was produced by JSON.stringify, so this always parses.
  const original = JSON.parse(input.baseSnapshot) as unknown;
  try {
    const prepared = prepareAiProposal({
      original,
      candidate: input.result.design,
      instruction: input.instruction,
      mode: input.mode,
      policyConfig: input.policyConfig,
    });
    if (prepared.status === 'no-change') return { status: 'no-change' };
    return { status: 'ready', proposal: prepared.proposal };
  } catch (error) {
    return {
      status: 'provider-error',
      code: 'invalid_response',
      message: error instanceof Error ? error.message : 'AI proposal could not be prepared.',
      retryable: false,
    };
  }
}
