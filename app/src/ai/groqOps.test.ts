/**
 * M8 tests for the BYOM operation engine (`./groqOps`).
 *
 * Covers the real production module: inventory building, operation
 * validation, safe application (escaping, no-mutation, fail-closed),
 * proposal preparation (diff/policy gates), and generation finalizing
 * (stale, provider errors, invalid output). No network, no mocks of our
 * own logic — only plain fixture designs.
 */
import { describe, expect, it } from 'vitest';
import {
  applyParagraphOps,
  buildParagraphInventory,
  finalizeGroqGeneration,
  GROQ_MAX_OPS,
  prepareGroqProposal,
  validateGroqOperations,
  type GroqParagraphOp,
} from './groqOps';
import { DEFAULT_POLICY_CONFIG } from '../engine/policies';

function richText(text: string): string {
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

function para(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'paragraph',
    values: { text: `<p>${text}</p>`, textJson: richText(text), ...extra },
  };
}

function design(contents: unknown[][], headers?: unknown): unknown {
  return {
    counters: {},
    body: {
      rows: contents.map((rowContents, rowIndex) => ({
        id: `row-${rowIndex}`,
        cells: [1],
        columns: [{ id: `row-${rowIndex}-col-0`, contents: rowContents, values: {} }],
        values: {},
      })),
      values: {},
      ...(headers !== undefined ? { headers } : {}),
    },
  };
}

function op(blockId: string, text: string): GroqParagraphOp {
  return { op: 'set_paragraph_text', blockId, text };
}

describe('buildParagraphInventory', () => {
  it('lists editable paragraphs and skips anything else', () => {
    const original = design([
      [
        para('p1', 'Hello'),
        { id: 'img-1', type: 'image', values: { src: 'https://example.com/y.png' } },
        para('locked-1', 'Nope', { locked: true }),
        { id: 'btn-1', type: 'button', values: { text: 'Click' } },
        para('p2', 'World'),
      ],
    ]);
    expect(buildParagraphInventory(original)).toEqual([
      { id: 'p1', text: 'Hello' },
      { id: 'p2', text: 'World' },
    ]);
  });

  it('excludes blocks without stable IDs or readable text', () => {
    const original = design([[para('', 'No id'), { id: 'x', type: 'paragraph', values: { text: '<p>x</p>' } }]]);
    expect(buildParagraphInventory(original)).toEqual([]);
  });

  it('returns [] for uninspectable input and truncates long text', () => {
    expect(buildParagraphInventory(null)).toEqual([]);
    expect(buildParagraphInventory({})).toEqual([]);
    const long = 'z'.repeat(500);
    const entries = buildParagraphInventory(design([[para('p1', long)]]));
    expect(entries).toHaveLength(1);
    expect(entries[0].text.length).toBeLessThan(long.length);
    expect(entries[0].text.endsWith('…')).toBe(true);
  });

  it('caps the block count', () => {
    const contents = Array.from({ length: 30 }, (_, i) => para(`p${i}`, `T${i}`));
    expect(buildParagraphInventory(design([contents]), { maxBlocks: 5 })).toHaveLength(5);
  });
});

describe('validateGroqOperations', () => {
  const inventory = [
    { id: 'p1', text: 'Hello' },
    { id: 'p2', text: 'World' },
  ];

  it('accepts well-formed operations for known blocks', () => {
    const { valid, dropped } = validateGroqOperations(
      { operations: [op('p1', 'Hi'), op('p2', 'Earth')] },
      inventory,
    );
    expect(valid).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it('drops unknown types, unknown blocks, empty and oversized text', () => {
    const { valid, dropped } = validateGroqOperations(
      {
        operations: [
          { op: 'delete_block', blockId: 'p1' },
          { op: 'set_paragraph_text', blockId: 'ghost', text: 'Hi' },
          { op: 'set_paragraph_text', blockId: 'p1', text: '   ' },
          { op: 'set_paragraph_text', blockId: 'p1', text: 'x'.repeat(5000) },
          'nonsense',
          op('p2', 'Kept'),
        ],
      },
      inventory,
    );
    expect(valid).toEqual([op('p2', 'Kept')]);
    expect(dropped).toHaveLength(5);
  });

  it('rejects missing operation arrays and caps operation counts', () => {
    expect(validateGroqOperations({ nope: [] }, inventory).valid).toEqual([]);
    expect(validateGroqOperations(null, inventory).dropped).toHaveLength(1);
    const many = Array.from({ length: GROQ_MAX_OPS + 4 }, (_, i) => op('p1', `T${i}`));
    const capped = validateGroqOperations({ operations: many }, inventory);
    expect(capped.valid).toHaveLength(GROQ_MAX_OPS);
    expect(capped.dropped.some((reason) => reason.includes('cap'))).toBe(true);
  });
});

describe('applyParagraphOps', () => {
  it('edits multiple blocks and leaves the input untouched', () => {
    const original = design([[para('p1', 'Hello'), para('p2', 'World')]]);
    const before = JSON.stringify(original);
    const candidate = applyParagraphOps(original, [op('p1', 'Hi'), op('p2', 'Earth')]);
    expect(JSON.stringify(original)).toBe(before);
    const text = JSON.stringify(candidate);
    expect(text).toContain('Hi');
    expect(text).toContain('Earth');
    expect(text).not.toContain('Hello');
  });

  it('escapes HTML and inserts $-patterns literally', () => {
    const original = design([[para('p1', 'Hello')]]);
    const candidate = applyParagraphOps(original, [op('p1', '<img src=x onerror=alert(1)> $&')]);
    const str = JSON.stringify(candidate);
    expect(str).toContain('&lt;img');
    expect(str).not.toMatch(/"text":"[^"]*<img/);
    expect(str).toContain('$&');
  });

  it('tolerates Unlayer normalization (escaped match)', () => {
    const original = design([[para('p1', 'A & B')]]);
    // Simulate a normalized design where values.text holds the escaped form.
    const normalized = JSON.parse(JSON.stringify(original)) as unknown as {
      body: { rows: Array<{ columns: Array<{ contents: Array<{ values: { text: string } }> }> }> };
    };
    normalized.body.rows[0].columns[0].contents[0].values.text = '<p>A &amp; B</p>';
    const candidate = applyParagraphOps(normalized, [op('p1', 'Changed')]);
    expect(JSON.stringify(candidate)).toContain('Changed');
  });

  it('fails closed on unknown, ambiguous, locked, or broken blocks', () => {
    const original = design([[para('p1', 'Hello')]]);
    expect(() => applyParagraphOps(original, [op('ghost', 'Hi')])).toThrow(/not uniquely addressable/);
    expect(() => applyParagraphOps(null, [op('p1', 'Hi')])).toThrow(/unavailable/);
    const locked = design([[para('p1', 'Hello', { locked: true })]]);
    expect(() => applyParagraphOps(locked, [op('p1', 'Hi')])).toThrow(/not an editable paragraph/);
    const dupes = design([[para('p1', 'A'), para('p1', 'B')]]);
    expect(() => applyParagraphOps(dupes, [op('p1', 'Hi')])).toThrow(/not uniquely addressable/);
  });
});

describe('prepareGroqProposal', () => {
  it('builds a reviewable AI proposal with diff and policies', () => {
    const original = design([[para('p1', 'Hello'), para('p2', 'World')]]);
    const outcome = prepareGroqProposal({ original, operations: [op('p1', 'Hi')], instruction: 'Greet briefly' });
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.proposal.diff.summary).toMatch(/1 change across 1 block/);
    expect(outcome.proposal.policyBlocked).toBe(false);
    expect(outcome.proposal.source).toMatchObject({ kind: 'ai', mode: 'edit' });
    // Candidate touches only the targeted block.
    expect(JSON.stringify(outcome.proposal.candidateDesign)).toContain('World');
  });

  it('reports no-change for empty or identical edits', () => {
    const original = design([[para('p1', 'Hello')]]);
    expect(prepareGroqProposal({ original, operations: [], instruction: 'Hi' })).toEqual({ status: 'no-change' });
    expect(prepareGroqProposal({ original, operations: [op('p1', 'Hello')], instruction: 'Hi' }).status).toBe('no-change');
  });

  it('fails closed on bad input, unsafe blocks, and incomplete diffs', () => {
    const original = design([[para('p1', 'Hello')]]);
    expect(() => prepareGroqProposal({ original, operations: [op('p1', 'Hi')], instruction: '  ' })).toThrow(/instruction/i);
    expect(() => prepareGroqProposal({ original: null, operations: [op('p1', 'Hi')], instruction: 'Hi' })).toThrow(/unavailable/);
    expect(() => prepareGroqProposal({ original, operations: [op('ghost', 'Hi')], instruction: 'Hi' })).toThrow();
    // Skipped non-array section => diff limitation => fail closed.
    const odd = design([[para('p1', 'Hello')]], 'oops');
    expect(() => prepareGroqProposal({ original: odd, operations: [op('p1', 'Hi')], instruction: 'Hi' })).toThrow(
      /could not be safely compared/,
    );
  });

  it('flags policy-blocked proposals without applying anything', () => {
    const original = design([[para('brand', 'Our brand'), para('p1', 'Body')]]);
    const outcome = prepareGroqProposal({
      original,
      operations: [op('brand', 'New brand')],
      instruction: 'Rebrand',
      policyConfig: { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['brand'] },
    });
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.proposal.policyBlocked).toBe(true);
  });
});

describe('finalizeGroqGeneration', () => {
  const original = design([[para('p1', 'Hello')]]);
  const snapshot = JSON.stringify(original);

  it('finalizes a happy-path turn into a ready proposal', () => {
    const outcome = finalizeGroqGeneration({
      result: { status: 'ready', operations: { operations: [op('p1', 'Hi')] }, model: 'test' },
      baseSnapshot: snapshot,
      liveDesign: JSON.parse(snapshot) as unknown,
      instruction: 'Greet',
    });
    expect(outcome.status).toBe('ready');
  });

  it('detects mid-generation canvas edits and passes provider states through', () => {
    const edited = design([[para('p1', 'Someone else')]]);
    expect(
      finalizeGroqGeneration({
        result: { status: 'ready', operations: { operations: [op('p1', 'Hi')] } },
        baseSnapshot: snapshot,
        liveDesign: edited,
        instruction: 'Greet',
      }).status,
    ).toBe('stale');
    expect(
      finalizeGroqGeneration({
        result: { status: 'no-change' },
        baseSnapshot: snapshot,
        liveDesign: JSON.parse(snapshot) as unknown,
        instruction: 'Greet',
      }).status,
    ).toBe('no-change');
    expect(
      finalizeGroqGeneration({
        result: { status: 'error', code: 'rate_limited', message: 'Slow down', retryable: true },
        baseSnapshot: snapshot,
        liveDesign: JSON.parse(snapshot) as unknown,
        instruction: 'Greet',
      }),
    ).toMatchObject({ status: 'provider-error', code: 'rate_limited' });
    expect(
      finalizeGroqGeneration({
        result: { status: 'not-configured' },
        baseSnapshot: snapshot,
        liveDesign: JSON.parse(snapshot) as unknown,
        instruction: 'Greet',
      }),
    ).toMatchObject({ status: 'provider-error', code: 'not-configured' });
  });

  it('converts unusable model output into provider errors, never proposals', () => {
    for (const operations of [{ operations: [{ op: 'nope', blockId: 'p1', text: 'Hi' }] }, { operations: [] }, null]) {
      const outcome = finalizeGroqGeneration({
        result: { status: 'ready', operations },
        baseSnapshot: snapshot,
        liveDesign: JSON.parse(snapshot) as unknown,
        instruction: 'Greet',
      });
      expect(outcome.status).toBe('provider-error');
    }
  });
});
