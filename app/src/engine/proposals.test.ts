/**
 * M2 regression suite for the pure proposal engine (`./proposals`).
 *
 * Runs in Vitest Node mode — no browser, no Unlayer iframe, no DOM.
 * Every test exercises actual production logic; the only doubles are the
 * `AgentPort` mocks standing in for the live `unlayer.agent` API.
 * Live-builder behaviors (rendering, autosave, refresh restore) remain
 * manual-QA items — see `docs/TESTING.md`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  approveEdit,
  escapeHtml,
  isDesignChanged,
  prepareParagraphEdit,
  type AgentPort,
  type PreparedParagraphEdit,
} from './proposals';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeRichText(text: string): string {
  return JSON.stringify({
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: 'normal', text, type: 'text', version: 1 }],
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

function makeParagraphContent(text: string, extraValues: Record<string, unknown> = {}) {
  return {
    id: 'para-1',
    type: 'paragraph',
    values: {
      text: `<p>${text}</p>`,
      textJson: makeRichText(text),
      ...extraValues,
    },
  };
}

function makeDesign(firstContent: unknown, extraContents: unknown[] = []) {
  return {
    counters: { u_row: 1, u_column: 1, u_content_paragraph: 1 },
    schemaVersion: 28,
    body: {
      id: 'body-1',
      rows: [
        {
          id: 'row-1',
          cells: [1],
          columns: [
            {
              id: 'col-1',
              contents: [firstContent, ...extraContents],
              values: {},
            },
          ],
          values: {},
        },
      ],
      values: {},
    },
  };
}

function firstParagraphValues(candidate: unknown): { text: string; textJson: string } {
  const design = candidate as {
    body?: {
      rows?: Array<{
        columns?: Array<{ contents?: Array<{ values?: { text?: unknown; textJson?: unknown } }> }>;
      }>;
    };
  };
  const values = design.body?.rows?.[0]?.columns?.[0]?.contents?.[0]?.values;
  if (typeof values?.text !== 'string' || typeof values?.textJson !== 'string') {
    throw new Error('Test fixture is missing paragraph values.');
  }
  return { text: values.text, textJson: values.textJson };
}

function lexicalText(textJson: string): string | undefined {
  const parsed = JSON.parse(textJson) as {
    root?: { children?: Array<{ children?: Array<{ text?: string }> }> };
  };
  return parsed.root?.children?.[0]?.children?.[0]?.text;
}

import type { AgentLoadDesignResult } from './types';
import { createPolicyGate, DEFAULT_POLICY_CONFIG, type PolicyConfig } from './policies';

function makePort(options: {
  liveDesign: unknown;
  loadResult?: AgentLoadDesignResult;
}) {
  const loadResult: AgentLoadDesignResult = {
    ok: true,
    loaded: true,
    errors: [],
    errorCount: 0,
    ...options.loadResult,
  };
  return {
    getDesign: vi.fn(async () => structuredClone(options.liveDesign)),
    loadDesign: vi.fn(async () => loadResult),
    backup: vi.fn(),
    onApplying: vi.fn(),
  };
}

function portOf(port: ReturnType<typeof makePort>): AgentPort {
  return { getDesign: port.getDesign, loadDesign: port.loadDesign };
}

/* ------------------------------------------------------------------ */
/* Preparation                                                         */
/* ------------------------------------------------------------------ */

describe('prepareParagraphEdit', () => {
  it('1. replaces the paragraph text and snapshots the base design', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'Sale starts Friday');

    expect(prepared.before).toBe('Hello world');
    expect(prepared.after).toBe('Sale starts Friday');
    expect(prepared.baseDesign).toBe(JSON.stringify(design));
    const values = firstParagraphValues(prepared.candidateDesign);
    expect(lexicalText(values.textJson)).toBe('Sale starts Friday');
    expect(values.text).toContain('Sale starts Friday');
  });

  it('2. rejects empty or whitespace-only replacement text', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    expect(() => prepareParagraphEdit(design, '')).toThrow('Enter replacement text first.');
    expect(() => prepareParagraphEdit(design, '   \n  ')).toThrow('Enter replacement text first.');
  });

  it('3. rejects designs without an editable first paragraph', () => {
    const empty: unknown = { counters: {}, body: { rows: [] } };
    expect(() => prepareParagraphEdit(empty, 'Hi')).toThrow(
      'First content block is not an editable paragraph.',
    );
    expect(() => prepareParagraphEdit(null, 'Hi')).toThrow(
      'First content block is not an editable paragraph.',
    );
  });

  it('4. rejects unsupported content block types', () => {
    const design = makeDesign({ id: 'img-1', type: 'image', values: { src: 'https://x/y.png' } });
    expect(() => prepareParagraphEdit(design, 'Hi')).toThrow(
      'First content block is not an editable paragraph.',
    );
  });

  it('5. rejects locked paragraphs', () => {
    const design = makeDesign(makeParagraphContent('Hello world', { locked: true }));
    expect(() => prepareParagraphEdit(design, 'Hi')).toThrow(
      'First content block is not an editable paragraph.',
    );
  });

  it('6. rejects malformed rich-text JSON', () => {
    const broken = makeDesign(makeParagraphContent('Hello world', { textJson: 'not-json{{{' }));
    expect(() => prepareParagraphEdit(broken, 'Hi')).toThrow(Error);

    const wrongShape = makeDesign(
      makeParagraphContent('Hello world', { textJson: JSON.stringify({ nope: true }) }),
    );
    expect(() => prepareParagraphEdit(wrongShape, 'Hi')).toThrow(
      'Paragraph text structure could not be safely updated.',
    );
  });

  it('7. never mutates the original design object', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const snapshot = JSON.stringify(design);
    const prepared = prepareParagraphEdit(design, 'Changed');

    expect(JSON.stringify(design)).toBe(snapshot);
    expect(prepared.candidateDesign).not.toBe(design);
    expect(lexicalText(firstParagraphValues(design).textJson)).toBe('Hello world');
  });

  it('8. keeps textJson and HTML text consistent', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'New & <improved>');
    const values = firstParagraphValues(prepared.candidateDesign);

    expect(lexicalText(values.textJson)).toBe('New & <improved>');
    expect(values.text).toContain(escapeHtml('New & <improved>'));
  });

  it('9. escapes user-supplied HTML and replacement patterns', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const payload = '<img src=x onerror=alert(1)>';
    const prepared = prepareParagraphEdit(design, payload);
    const values = firstParagraphValues(prepared.candidateDesign);

    expect(values.text).not.toContain('<img');
    expect(values.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // textJson holds the raw text; JSON encoding (not HTML) applies there.
    expect(lexicalText(values.textJson)).toBe(payload);

    const tricky = prepareParagraphEdit(design, '$&-$`');
    expect(firstParagraphValues(tricky.candidateDesign).text).toBe('<p>$&amp;-$`</p>');
  });

  it('re-edits a block normalized by a prior approval round-trip', () => {
    // After Unlayer loads an approved edit, values.text may hold the escaped
    // form while textJson holds the raw text. The next prepare must match
    // the escaped occurrence instead of failing closed incorrectly.
    const design = makeDesign(makeParagraphContent('Hello'));
    const first = prepareParagraphEdit(design, 'A & <tag>');
    // The second edit starts from the previously approved candidate, exactly
    // as getDesign would return it after the round-trip.
    const second = prepareParagraphEdit(first.candidateDesign, 'Final');

    expect(second.before).toBe('A & <tag>');
    expect(lexicalText(firstParagraphValues(second.candidateDesign).textJson)).toBe('Final');
    expect(firstParagraphValues(second.candidateDesign).text).toContain('Final');
    expect(firstParagraphValues(second.candidateDesign).text).not.toContain('&lt;tag&gt;');
  });

  it('still fails closed when neither raw nor escaped text is present', () => {
    const design = makeDesign(makeParagraphContent('Hello'));
    const contents = (
      design as unknown as {
        body: { rows: Array<{ columns: Array<{ contents: Array<{ values: { text: string } }> }> }> };
      }
    ).body.rows[0].columns[0].contents;
    contents[0].values.text = '<p>Something else entirely</p>';
    expect(() => prepareParagraphEdit(design, 'Next')).toThrow(
      'Paragraph text structure could not be safely updated.',
    );
  });

  it('16. preserves unrelated image and content blocks', () => {
    const image = { id: 'img-1', type: 'image', values: { src: 'https://x/y.png', alt: 'Y' } };
    const button = { id: 'btn-1', type: 'button', values: { text: 'Buy', href: 'https://x' } };
    const design = makeDesign(makeParagraphContent('Hello world'), [image, button]);

    const prepared = prepareParagraphEdit(design, 'Changed');
    const contents = (
      prepared.candidateDesign as unknown as {
        body: { rows: Array<{ columns: Array<{ contents: unknown[] }> }> };
      }
    ).body.rows[0].columns[0].contents;

    expect(contents[1]).toEqual(image);
    expect(contents[2]).toEqual(button);
  });

  it('attaches a structured local diff to the proposal', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'Changed');

    expect(prepared.diff.complete).toBe(true);
    expect(prepared.diff.limitations).toEqual([]);
    expect(prepared.diff.summary).toBe('1 change across 1 block');
    expect(prepared.diff.counts).toEqual({ added: 0, removed: 0, modified: 1, moved: 0 });
    expect(prepared.diff.changes).toHaveLength(1);
    const [change] = prepared.diff.changes;
    expect(change.kind).toBe('modified');
    expect(change.label).toBe('Paragraph text');
    expect(change.before).toBe('Hello world');
    expect(change.after).toBe('Changed');
    expect(change.path).toBe('body.rows[0].columns[0].contents[0].values.textJson');
  });
  it('attaches policy findings that pass under the default config', () => {
    const design = makeDesign(
      makeParagraphContent('Hello'),
      [{ id: 'b1', type: 'button', values: { text: 'Buy', href: { name: 'web', values: { href: 'https://example.com/shop', target: '_blank' } } } }],
    );
    const prepared = prepareParagraphEdit(design, 'Changed');

    expect(prepared.policies).toHaveLength(4);
    for (const policy of prepared.policies) expect(policy.verdict).toBe('PASS');
    expect(prepared.policyBlocked).toBe(false);
  });

  it('flags policy violations at prepare time without blocking the demo flow', () => {
    const strict: PolicyConfig = { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] };
    const design = makeDesign(
      makeParagraphContent('Hello'),
      [{ id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://evil.example/shop' } }],
    );
    const prepared = prepareParagraphEdit(design, 'Changed', strict);

    expect(prepared.policyBlocked).toBe(true);
    expect(prepared.policies.some((policy) => policy.ruleId === 'allowed-link-domains' && policy.verdict === 'FAIL')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

describe('approveEdit', () => {
  it('10. approves a valid proposal against an unchanged design', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'Approved text');
    const loadResult: AgentLoadDesignResult = {
      ok: true,
      loaded: true,
      errors: [],
      errorCount: 0,
      protectedElements: ['locked-1'],
      audit: {
        status: 'PASS',
        issues: [
          {
            severity: 'WARNING',
            title: 'Missing alt text',
            description: 'An image has no alternative text.',
            elementId: 'img-1',
          },
        ],
        issueCount: 1,
      },
    };
    const port = makePort({ liveDesign: design, loadResult });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
      onApplying: port.onApplying,
    });

    expect(outcome).toEqual({ status: 'applied', native: loadResult });
    expect(port.getDesign).toHaveBeenCalledTimes(1);
    expect(port.backup).toHaveBeenCalledTimes(1);
    expect(port.backup).toHaveBeenCalledWith(prepared.baseDesign);
    expect(port.loadDesign).toHaveBeenCalledTimes(1);
    expect(port.loadDesign).toHaveBeenCalledWith(prepared.candidateDesign);
    expect(port.onApplying).toHaveBeenCalledTimes(1);
    // Backup happens before the load, never after.
    expect(port.backup.mock.invocationCallOrder[0]).toBeLessThan(
      port.loadDesign.mock.invocationCallOrder[0],
    );
  });

  it('11. discarding a proposal performs no agent I/O', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const snapshot = JSON.stringify(design);
    const port = makePort({ liveDesign: design });

    const prepared: PreparedParagraphEdit = prepareParagraphEdit(design, 'Never applied');
    // The user discards `prepared`: approveEdit is never invoked with it.
    expect(prepared.after).toBe('Never applied');
    expect(port.getDesign).not.toHaveBeenCalled();
    expect(port.loadDesign).not.toHaveBeenCalled();
    expect(JSON.stringify(design)).toBe(snapshot);

    // The runner itself is a no-op without a proposal.
    const outcome = await approveEdit(portOf(port), null, {
      alreadyApplying: false,
      backup: port.backup,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-proposal' });
    expect(port.getDesign).not.toHaveBeenCalled();
  });

  it('12. rejects a proposal when the design changed', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'New text');
    const editedLive = makeDesign(makeParagraphContent('Someone edited meanwhile'));
    const port = makePort({ liveDesign: editedLive });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
      onApplying: port.onApplying,
    });

    expect(outcome).toEqual({ status: 'stale' });
    expect(port.loadDesign).not.toHaveBeenCalled();
    expect(port.backup).not.toHaveBeenCalled();
    expect(port.onApplying).not.toHaveBeenCalled();
  });

  it('13. surfaces Unlayer validation failures without applying', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'New text');
    const loadResult: AgentLoadDesignResult = {
      ok: false,
      loaded: false,
      errors: [
        {
          path: 'body.rows[0].columns[0].contents[0].values.textJson',
          message: 'Paragraph is missing values.textJson',
          code: 'invalid_type',
        },
        {
          path: 'body.rows[0].columns[0].contents[1]',
          message: 'Unknown block type',
          code: 'unknown_type',
        },
      ],
      errorCount: 2,
      protectedElements: ['locked-9'],
      audit: { status: 'FAIL', issues: [], issueCount: 0 },
    };
    const port = makePort({ liveDesign: design, loadResult });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
    });

    expect(outcome).toEqual({
      status: 'rejected',
      message: 'Paragraph is missing values.textJson; Unknown block type',
      native: loadResult,
    });
    expect(port.backup).toHaveBeenCalledTimes(1); // backup precedes the load, as in production
  });

  it('14. propagates unavailable-agent errors without side effects', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'New text');
    const failingGet = vi.fn(async () => {
      throw new Error('Agent API unavailable');
    });
    const loadDesign = vi.fn(async () => ({
      ok: true,
      loaded: true,
      errors: [],
      errorCount: 0,
    }));
    const backup = vi.fn();

    await expect(
      approveEdit({ getDesign: failingGet, loadDesign }, prepared, {
        alreadyApplying: false,
        backup,
      }),
    ).rejects.toThrow('Agent API unavailable');
    expect(loadDesign).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it('15. prevents duplicate simultaneous approval', async () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const prepared = prepareParagraphEdit(design, 'New text');
    const port = makePort({ liveDesign: design });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: true,
      backup: port.backup,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'already-applying' });
    expect(port.getDesign).not.toHaveBeenCalled();
    expect(port.loadDesign).not.toHaveBeenCalled();
    expect(port.backup).not.toHaveBeenCalled();
  });

  it('blocks approval when the policy gate fails, before any backup or load', async () => {
    const strict: PolicyConfig = { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] };
    const design = makeDesign(
      makeParagraphContent('Hello world'),
      [{ id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://evil.example/shop' } }],
    );
    const prepared = prepareParagraphEdit(design, 'New text', strict);
    expect(prepared.policyBlocked).toBe(true);
    const port = makePort({ liveDesign: design });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
      policyGate: createPolicyGate(strict, prepared.baseDesign),
    });

    expect(outcome.status).toBe('blocked');
    expect(port.getDesign).toHaveBeenCalledTimes(1);
    expect(port.backup).not.toHaveBeenCalled();
    expect(port.loadDesign).not.toHaveBeenCalled();
    expect(port.onApplying).not.toHaveBeenCalled();
  });

  it('permits approval with advisory warnings', async () => {
    const design = makeDesign(
      makeParagraphContent('Hello world'),
      [{ id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://external.example/shop' } }],
    );
    const prepared = prepareParagraphEdit(design, 'New text');
    expect(prepared.policyBlocked).toBe(false);
    expect(prepared.policies.some((policy) => policy.verdict === 'WARN')).toBe(true);
    const port = makePort({ liveDesign: design });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
      onApplying: port.onApplying,
      policyGate: createPolicyGate(DEFAULT_POLICY_CONFIG, prepared.baseDesign),
    });

    expect(outcome.status).toBe('applied');
    expect(port.loadDesign).toHaveBeenCalledTimes(1);
  });

  it('rechecks policies at approval time against the current config', async () => {
    const design = makeDesign(
      makeParagraphContent('Hello world'),
      [{ id: 'b1', type: 'button', values: { text: 'Buy', href: 'https://evil.example/shop' } }],
    );
    const prepared = prepareParagraphEdit(design, 'New text');
    expect(prepared.policyBlocked).toBe(false);
    const strict: PolicyConfig = { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] };
    const port = makePort({ liveDesign: design });

    const outcome = await approveEdit(portOf(port), prepared, {
      alreadyApplying: false,
      backup: port.backup,
      policyGate: createPolicyGate(strict, prepared.baseDesign),
    });

    expect(outcome.status).toBe('blocked');
    expect(port.loadDesign).not.toHaveBeenCalled();
  });

  it('stale check compares serialized designs', () => {
    const design = makeDesign(makeParagraphContent('Hello world'));
    const base = JSON.stringify(design);
    expect(isDesignChanged(structuredClone(design), base)).toBe(false);
    expect(isDesignChanged(makeDesign(makeParagraphContent('Other')), base)).toBe(true);
  });
});
