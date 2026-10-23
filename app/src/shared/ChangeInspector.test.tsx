/**
 * M3 inspector UI tests via server rendering (no browser, no DOM).
 *
 * `renderToStaticMarkup` executes the real `ChangeInspector` and
 * `NativeResultPanel` components in Node and asserts on the HTML string.
 * This covers the display contract that matters most for a review tool:
 * untrusted values are escaped, native results are surfaced, and controls
 * keep their labels. Interaction (clicks) still requires the browser.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prepareParagraphEdit } from '../engine/proposals';
import { prepareAiProposal, finalizeAiGeneration } from '../ai/aiProposals';
import type { PolicyConfig } from '../engine/policies';
import type { AgentLoadDesignResult } from '../engine/types';
import { ChangeInspector, NativeResultPanel } from './ChangeInspector';

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

function makeDesign(text: string): unknown {
  return {
    counters: {},
    body: {
      rows: [
        {
          id: 'row-0',
          cells: [1],
          columns: [
            {
              id: 'row-0-col-0',
              contents: [
                {
                  id: 'para-1',
                  type: 'paragraph',
                  values: { text: `<p>${text}</p>`, textJson: makeRichText(text) },
                },
              ],
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

const noop = (): void => {};

function makeDesignWithButton(href: string): unknown {
  return {
    counters: {},
    body: {
      rows: [
        {
          id: 'row-0',
          cells: [1],
          columns: [
            {
              id: 'row-0-col-0',
              contents: [
                {
                  id: 'para-1',
                  type: 'paragraph',
                  values: { text: '<p>Hello</p>', textJson: makeRichText('Hello') },
                },
                { id: 'b1', type: 'button', values: { text: 'Buy', href } },
              ],
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

describe('ChangeInspector', () => {
  it('renders the summary, counts, and before/after values', () => {
    const proposal = prepareParagraphEdit(makeDesign('Hello'), 'Goodbye');
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={false} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('Proposed Change');
    expect(html).toContain('1 change across 1 block');
    expect(html).toContain('Hello');
    expect(html).toContain('Goodbye');
    expect(html).toContain('Paragraph text');
    expect(html).toContain('Approve Change');
    expect(html).toContain('Discard Proposal');
  });

  it('escapes untrusted design text instead of injecting HTML', () => {
    const proposal = prepareParagraphEdit(makeDesign('Hello'), '<img src=x onerror=alert(1)>');
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={false} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('lists native validation errors with path and code', () => {
    const proposal = prepareParagraphEdit(makeDesign('Hello'), 'Goodbye');
    const rejection: AgentLoadDesignResult = {
      ok: false,
      loaded: false,
      errors: [
        {
          path: 'body.rows[0].columns[0].contents[0].values.textJson',
          message: 'Paragraph is missing values.textJson',
          code: 'invalid_type',
        },
      ],
      errorCount: 1,
    };
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={false} rejection={rejection} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('Unlayer rejected this change');
    expect(html).toContain('body.rows[0].columns[0].contents[0].values.textJson');
    expect(html).toContain('invalid_type');
  });

  it('disables approval while applying', () => {
    const proposal = prepareParagraphEdit(makeDesign('Hello'), 'Goodbye');
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={true} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('Applying...');
    expect(html).toContain('disabled');
  });
});

describe('ChangeInspector policies', () => {
  const strict: PolicyConfig = { allowedLinkDomains: ['example.com'], requiredDisclaimer: null, protectedBlockIds: [] };

  it('shows failing policies and blocks approval', () => {
    const proposal = prepareParagraphEdit(makeDesignWithButton('https://evil.example/shop'), 'Goodbye', strict);
    expect(proposal.policyBlocked).toBe(true);
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={false} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('Application policy checks');
    expect(html).toContain('Allowed link domains');
    expect(html).toContain('Failed');
    expect(html).toContain('Approval blocked by application policy');
    expect(html).toContain('separate from Unlayer');
    expect(html).toContain('disabled');
  });

  it('shows warnings without blocking approval', () => {    const proposal = prepareParagraphEdit(makeDesignWithButton('https://external.example/shop'), 'Goodbye');
    expect(proposal.policyBlocked).toBe(false);
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={proposal} isApplying={false} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('External link target');
    expect(html).toContain('Warning');
    expect(html).not.toContain('Approval blocked by application policy');
    expect(html).not.toContain('disabled');
  });
});

describe('NativeResultPanel', () => {
  it('displays protected elements and audit issues', () => {
    const result: AgentLoadDesignResult = {
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
    const html = renderToStaticMarkup(<NativeResultPanel title="Last applied change" result={result} />);

    expect(html).toContain('Last applied change');
    expect(html).toContain('Applied successfully');
    expect(html).toContain('locked-1');
    expect(html).toContain('PASS');
    expect(html).toContain('Missing alt text');
    expect(html).toContain('img-1');
  });

  it('handles missing audit and empty protected elements', () => {
    const result: AgentLoadDesignResult = {
      ok: true,
      loaded: true,
      errors: [],
      errorCount: 0,
      protectedElements: [],
      audit: null,
    };
    const html = renderToStaticMarkup(<NativeResultPanel title="Last applied change" result={result} />);

    expect(html).toContain('None');
    expect(html).toContain('Audit unavailable');
  });
});

describe('ChangeInspector AI proposals', () => {
  const base = {
    counters: {},
    body: {
      rows: [
        {
          id: 'row-0',
          cells: [1],
          columns: [
            {
              id: 'row-0-col-0',
              contents: [
                {
                  id: 'para-1',
                  type: 'paragraph',
                  values: { text: '<p>Hello</p>', textJson: makeRichText('Hello') },
                },
              ],
              values: {},
            },
          ],
          values: {},
        },
      ],
      values: {},
    },
  };

  it('labels the AI instruction instead of manual before/after', () => {
    const finalized = finalizeAiGeneration({
      result: {
        status: 'ready',
        design: {
          counters: {},
          body: {
            rows: [
              {
                id: 'row-0',
                cells: [1],
                columns: [
                  {
                    id: 'row-0-col-0',
                    contents: [
                      {
                        id: 'para-1',
                        type: 'paragraph',
                        values: { text: '<p>Sale!</p>', textJson: makeRichText('Sale!') },
                      },
                    ],
                    values: {},
                  },
                ],
                values: {},
              },
            ],
            values: {},
          },
        },
      },
      baseSnapshot: JSON.stringify(base),
      liveDesign: structuredClone(base),
      instruction: 'Announce the sale',
      mode: 'edit',
    });
    expect(finalized.status).toBe('ready');
    if (finalized.status !== 'ready') throw new Error('unreachable');
    const html = renderToStaticMarkup(
      <ChangeInspector proposal={finalized.proposal} isApplying={false} rejection={null} onApprove={noop} onDiscard={noop} />,
    );

    expect(html).toContain('AI instruction (Edit current)');
    expect(html).toContain('Announce the sale');
    expect(html).not.toContain('<strong>Before:</strong>');
    expect(html).toContain('1 change across 1 block');
  });

  it('routes an unchecked prepareAiProposal through finalize safely', () => {
    const prepared = prepareAiProposal({
      original: base,
      candidate: { counters: {}, body: { rows: [] } },
      instruction: 'Empty it',
      mode: 'create',
    });
    expect(prepared.status).toBe('ready');
  });
});
