/**
 * M5 tests for AI proposal assembly (`./aiProposals`).
 *
 * Covers the journey from a provider result to a reviewable proposal that
 * the unchanged approval engine can apply — including every fail-closed
 * path (malformed output, ambiguous diff, mid-generation canvas edits).
 */
import { describe, expect, it, vi } from 'vitest';
import { approveEdit, type AgentPort } from '../engine/proposals';
import { createPolicyGate, type PolicyConfig } from '../engine/policies';
import type { AgentLoadDesignResult } from '../engine/types';
import { finalizeAiGeneration, prepareAiProposal } from './aiProposals';
import type { AiGenerateResult } from './aiProvider';

function makeRichText(text: string): string {
  return JSON.stringify({
    root: {
      children: [
        {
          children: [{ text, type: 'text', version: 1 }],
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

function para(id: string, text: string) {
  return { id, type: 'paragraph', values: { text: `<p>${text}</p>`, textJson: makeRichText(text) } };
}

function design(rows: unknown[][]): unknown {
  return {
    counters: {},
    schemaVersion: 28,
    body: {
      rows: rows.map((contents, rowIndex) => ({
        id: `row-${rowIndex}`,
        cells: [1],
        columns: [{ id: `row-${rowIndex}-col-0`, contents, values: {} }],
        values: {},
      })),
      values: {},
    },
  };
}

function successResult(design: unknown): AiGenerateResult {
  return { status: 'ready', design };
}

function makePort(liveDesign: unknown): { port: AgentPort; loadDesign: ReturnType<typeof vi.fn> } {
  const loadDesign = vi.fn(async () => ({
    ok: true,
    loaded: true,
    errors: [],
    errorCount: 0,
  }));
  return {
    port: { getDesign: async () => structuredClone(liveDesign), loadDesign },
    loadDesign,
  };
}

describe('prepareAiProposal', () => {
  it('builds a reviewable proposal from a valid AI design', () => {
    const original = design([[para('p1', 'Hello')]]);
    const candidate = design([[para('p1', 'Spring sale is here')]]);
    const outcome = prepareAiProposal({ original, candidate, instruction: 'Announce the spring sale', mode: 'edit' });

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('unreachable');
    expect(outcome.proposal.baseDesign).toBe(JSON.stringify(original));
    expect(outcome.proposal.source).toEqual({ kind: 'ai', mode: 'edit', instruction: 'Announce the spring sale' });
    expect(outcome.proposal.after).toBe('Announce the spring sale');
    expect(outcome.proposal.diff.summary).toBe('1 change across 1 block');
    expect(outcome.proposal.policyBlocked).toBe(false);
  });

  it('supports whole new designs in create mode', () => {
    const original = design([[para('p1', 'Hello')]]);
    const candidate = design([[para('n1', 'Brand new'), para('n2', 'More news')]]);
    const outcome = prepareAiProposal({ original, candidate, instruction: 'Fresh newsletter', mode: 'create' });

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('unreachable');
    expect(outcome.proposal.source).toMatchObject({ kind: 'ai', mode: 'create' });
    expect(outcome.proposal.diff.counts.added).toBeGreaterThan(0);
  });

  it('rejects unusable AI output without touching anything', () => {
    const original = design([[para('p1', 'Hello')]]);
    for (const candidate of [null, 'design?', 42, { counters: {} }, { body: null }]) {
      expect(() => prepareAiProposal({ original, candidate, instruction: 'Go', mode: 'edit' })).toThrow(
        'unusable design',
      );
    }
    expect(() => prepareAiProposal({ original, candidate: original, instruction: '   ', mode: 'edit' })).toThrow(
      'Enter an AI instruction first.',
    );
  });

  it('returns no-change when the AI design matches the base', () => {
    const original = design([[para('p1', 'Hello')]]);
    expect(
      prepareAiProposal({ original, candidate: structuredClone(original), instruction: 'Same', mode: 'edit' }),
    ).toEqual({ status: 'no-change' });
  });

  it('fails closed on ambiguous or unsupported structures', () => {
    const original = design([[para('p1', 'Hello')]]);
    const candidate = design([[para('p1', 'Hi'), para('p1', 'Duplicate')]]);
    expect(() => prepareAiProposal({ original, candidate, instruction: 'Go', mode: 'edit' })).toThrow(
      /could not be safely compared/,
    );
  });

  it('flags policy-blocked AI proposals', () => {
    const original = design([[para('p1', 'Hello')]]);
    const candidate = design([
      [para('p1', 'Hello'), { id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://evil.example/x' } }],
    ]);
    const outcome = prepareAiProposal({
      original,
      candidate,
      instruction: 'Add a shop button',
      mode: 'edit',
      policyConfig: { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] },
    });

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') throw new Error('unreachable');
    expect(outcome.proposal.policyBlocked).toBe(true);
  });
});

describe('finalizeAiGeneration', () => {
  it('passes provider errors through with codes', () => {
    const outcome = finalizeAiGeneration({
      result: { status: 'error', code: 'rate_limited', message: 'Slow down.', retryable: true },
      baseSnapshot: '{}',
      liveDesign: {},
      instruction: 'Go',
      mode: 'edit',
    });
    expect(outcome).toEqual({ status: 'provider-error', code: 'rate_limited', message: 'Slow down.', retryable: true });
  });

  it('maps not-configured to an actionable message', () => {
    const outcome = finalizeAiGeneration({
      result: { status: 'not-configured' },
      baseSnapshot: '{}',
      liveDesign: {},
      instruction: 'Go',
      mode: 'edit',
    });
    expect(outcome.status).toBe('provider-error');
    if (outcome.status !== 'provider-error') throw new Error('unreachable');
    expect(outcome.code).toBe('not-configured');
    expect(outcome.message).toContain('AI_STUDIO');
  });

  it('discards the AI design when the canvas changed mid-generation', () => {
    const base = design([[para('p1', 'Hello')]]);
    const editedLive = design([[para('p1', 'Someone edited meanwhile')]]);
    const outcome = finalizeAiGeneration({
      result: successResult(design([[para('p1', 'AI text')]])),
      baseSnapshot: JSON.stringify(base),
      liveDesign: editedLive,
      instruction: 'Change it',
      mode: 'edit',
    });
    expect(outcome).toEqual({ status: 'stale' });
  });

  it('approves and rejects AI proposals through the unchanged approval flow', async () => {
    const base = design([[para('p1', 'Hello')]]);
    const finalized = finalizeAiGeneration({
      result: successResult(design([[para('p1', 'AI text')]])),
      baseSnapshot: JSON.stringify(base),
      liveDesign: structuredClone(base),
      instruction: 'Change it',
      mode: 'edit',
    });
    expect(finalized.status).toBe('ready');
    if (finalized.status !== 'ready') throw new Error('unreachable');

    const { port, loadDesign } = makePort(base);
    const applied = await approveEdit(port, finalized.proposal, {
      alreadyApplying: false,
      backup: () => {},
    });
    expect(applied.status).toBe('applied');
    expect(loadDesign).toHaveBeenCalledTimes(1);

    const failingLoad = vi.fn(async (): Promise<AgentLoadDesignResult> => ({
      ok: false,
      loaded: false,
      errors: [{ path: 'body.rows[0]', message: 'Rejected by native validation', code: 'invalid_type' }],
      errorCount: 1,
    }));
    const rejected = await approveEdit(
      { getDesign: async () => structuredClone(base), loadDesign: failingLoad },
      finalized.proposal,
      { alreadyApplying: false, backup: () => {} },
    );
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('unreachable');
    expect(rejected.native.errors[0].code).toBe('invalid_type');
  });

  it('blocks policy-violating AI proposals before any load', async () => {
    const base = design([[para('p1', 'Hello')]]);
    const finalized = finalizeAiGeneration({
      result: successResult(
        design([[para('p1', 'Hello'), { id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://evil.example/x' } }]]),
      ),
      baseSnapshot: JSON.stringify(base),
      liveDesign: structuredClone(base),
      instruction: 'Add a shop button',
      mode: 'edit',
      policyConfig: { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] },
    });
    expect(finalized.status).toBe('ready');
    if (finalized.status !== 'ready') throw new Error('unreachable');
    expect(finalized.proposal.policyBlocked).toBe(true);

    const { port, loadDesign } = makePort(base);
    const strict: PolicyConfig = { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] };
    const outcome = await approveEdit(port, finalized.proposal, {
      alreadyApplying: false,
      backup: () => {},
      policyGate: createPolicyGate(strict, finalized.proposal.baseDesign),
    });
    expect(outcome.status).toBe('blocked');
    expect(loadDesign).not.toHaveBeenCalled();
  });
});
