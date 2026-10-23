/**
 * M4 regression suite for the application policy engine (`./policies`).
 *
 * Node-mode Vitest, no browser. Every test exercises the real
 * `evaluatePolicies` / `createPolicyGate` logic against plain design JSON.
 */
import { describe, expect, it } from 'vitest';
import {
  createPolicyGate,
  DEFAULT_POLICY_CONFIG,
  evaluatePolicies,
  type PolicyConfig,
} from './policies';

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

function para(id: string, text: string) {
  return { id, type: 'paragraph', values: { text: `<p>${text}</p>`, textJson: makeRichText(text) } };
}

function button(id: string, href?: string | { href?: string; target?: string }, text = 'Buy') {
  const values: Record<string, unknown> =
    href === undefined
      ? { text }
      : typeof href === 'string'
        ? { text, href }
        : { text, href: { name: 'web', values: { href: href.href, target: href.target } } };
  return { id, type: 'button', values };
}

/** Each inner array is the contents of one single-column row. */
function design(rows: unknown[][]): unknown {
  return {
    counters: {},
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

const clone = (value: unknown): unknown => structuredClone(value);

function resultOf(results: ReturnType<typeof evaluatePolicies>['results'], ruleId: string) {
  const found = results.find((result) => result.ruleId === ruleId);
  if (!found) throw new Error(`Missing policy result for ${ruleId}`);
  return found;
}

describe('evaluatePolicies', () => {
  it('passes vacuously under the default config', () => {
    const candidate = design([[para('p1', 'Hello'), button('b1', { href: 'https://anything.example/shop', target: '_blank' })]]);
    const evaluation = evaluatePolicies({ candidate, original: design([[para('p1', 'Hello')]]) });

    expect(evaluation.results).toHaveLength(4);
    for (const result of evaluation.results) expect(result.verdict).toBe('PASS');
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.complete).toBe(true);
  });

  it('accepts allowed link domains', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['example.com'] };
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', 'https://example.com/shop')]]),
      config,
    });
    expect(resultOf(evaluation.results, 'allowed-link-domains').verdict).toBe('PASS');
    expect(evaluation.blocked).toBe(false);
  });

  it('rejects disallowed link domains with block identity', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['example.com'] };
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', 'https://evil.example/shop')]]),
      config,
    });
    const result = resultOf(evaluation.results, 'allowed-link-domains');
    expect(result.verdict).toBe('FAIL');
    expect(result.blockIds).toEqual(['b1']);
    expect(result.paths).toEqual(['body.rows[0].columns[0].contents[0]']);
    expect(result.message).toContain('evil.example');
    expect(evaluation.blocked).toBe(true);
  });

  it('normalizes domains before comparison', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['Example.COM.'] };
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', '  HTTPS://example.com:443/shop  ')]]),
      config,
    });
    expect(resultOf(evaluation.results, 'allowed-link-domains').verdict).toBe('PASS');
  });

  it('treats subdomains as distinct hosts', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['example.com'] };
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', 'https://shop.example.com/')]]),
      config,
    });
    expect(resultOf(evaluation.results, 'allowed-link-domains').verdict).toBe('FAIL');
  });

  it('answers UNKNOWN for missing, relative, and non-web URLs', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['example.com'] };
    for (const href of [undefined, '/relative/path', 'mailto:hi@example.com', 'not a url'] as const) {
      const evaluation = evaluatePolicies({ candidate: design([[button('b1', href)]]), config });
      const result = resultOf(evaluation.results, 'allowed-link-domains');
      expect(result.verdict).toBe('UNKNOWN');
      expect(evaluation.blocked).toBe(true);
    }
  });

  it('detects a present disclaimer by text', () => {
    const config: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      requiredDisclaimer: { text: 'You received this because you subscribed.' },
    };
    const good = evaluatePolicies({
      candidate: design([[para('p1', 'Hello'), para('d1', 'Fine print: You received this because you subscribed.')]]),
      config,
    });
    expect(resultOf(good.results, 'required-disclaimer').verdict).toBe('PASS');

    const bad = evaluatePolicies({ candidate: design([[para('p1', 'Hello')]]), config });
    expect(resultOf(bad.results, 'required-disclaimer').verdict).toBe('FAIL');
    expect(bad.blocked).toBe(true);
  });

  it('detects a required disclaimer block by id', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, requiredDisclaimer: { blockId: 'd1' } };
    const present = evaluatePolicies({ candidate: design([[para('d1', 'Fine print')]]), config });
    expect(resultOf(present.results, 'required-disclaimer').verdict).toBe('PASS');
    expect(resultOf(present.results, 'required-disclaimer').blockIds).toEqual(['d1']);

    const missing = evaluatePolicies({ candidate: design([[para('p1', 'Hello')]]), config });
    expect(resultOf(missing.results, 'required-disclaimer').verdict).toBe('FAIL');
  });

  it('answers UNKNOWN for the disclaimer when nothing can be inspected', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, requiredDisclaimer: { text: 'Fine print' } };
    const evaluation = evaluatePolicies({ candidate: null, config });
    expect(resultOf(evaluation.results, 'required-disclaimer').verdict).toBe('UNKNOWN');
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.complete).toBe(false);
  });

  it('passes protected sections that are unchanged', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['brand'] };
    const evaluation = evaluatePolicies({
      candidate: design([[para('brand', 'Brand'), para('p1', 'Changed')]]),
      original: design([[para('brand', 'Brand'), para('p1', 'Old')]]),
      config,
    });
    expect(resultOf(evaluation.results, 'protected-sections').verdict).toBe('PASS');
    expect(evaluation.blocked).toBe(false);
  });

  it('fails protected sections that changed, moved, or were removed', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['brand'] };

    const changed = evaluatePolicies({
      candidate: design([[para('brand', 'Edited'), para('p1', 'x')]]),
      original: design([[para('brand', 'Brand'), para('p1', 'x')]]),
      config,
    });
    expect(resultOf(changed.results, 'protected-sections').verdict).toBe('FAIL');
    expect(resultOf(changed.results, 'protected-sections').blockIds).toEqual(['brand']);

    const removed = evaluatePolicies({
      candidate: design([[para('p1', 'x')]]),
      original: design([[para('brand', 'Brand'), para('p1', 'x')]]),
      config,
    });
    expect(resultOf(removed.results, 'protected-sections').verdict).toBe('FAIL');

    const moved = evaluatePolicies({
      candidate: design([[para('p1', 'x'), para('brand', 'Brand')]]),
      original: design([[para('brand', 'Brand'), para('p1', 'x')]]),
      config,
    });
    expect(resultOf(moved.results, 'protected-sections').verdict).toBe('FAIL');
    expect(moved.blocked).toBe(true);
  });

  it('warns when a protected id was never in the original design', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['ghost'] };
    const evaluation = evaluatePolicies({
      candidate: design([[para('p1', 'Hello')]]),
      original: design([[para('p1', 'Hello')]]),
      config,
    });
    const result = resultOf(evaluation.results, 'protected-sections');
    expect(result.verdict).toBe('WARN');
    expect(evaluation.blocked).toBe(false);
  });

  it('answers UNKNOWN for protected sections without an original design', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['brand'] };
    const evaluation = evaluatePolicies({ candidate: design([[para('brand', 'Brand')]]), config });
    expect(resultOf(evaluation.results, 'protected-sections').verdict).toBe('UNKNOWN');
    expect(evaluation.blocked).toBe(true);
  });

  it('warns on external links without a new-tab target without blocking', () => {
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', { href: 'https://external.example/x' })]]),
    });
    const result = resultOf(evaluation.results, 'external-link-target');
    expect(result.verdict).toBe('WARN');
    expect(result.blockIds).toEqual(['b1']);
    expect(evaluation.blocked).toBe(false);
  });

  it('passes external links that open in a new tab', () => {
    const evaluation = evaluatePolicies({
      candidate: design([[button('b1', { href: 'https://external.example/x', target: '_blank' })]]),
    });
    expect(resultOf(evaluation.results, 'external-link-target').verdict).toBe('PASS');
    expect(evaluation.blocked).toBe(false);
  });

  it('skips relative links in the advisory check with a note', () => {
    const evaluation = evaluatePolicies({ candidate: design([[button('b1', '/local/page')]]) });
    const result = resultOf(evaluation.results, 'external-link-target');
    expect(result.verdict).toBe('PASS');
    expect(result.message).toContain('skipped');
  });

  it('never mutates its inputs and stays deterministic', () => {
    const candidate = design([[para('p1', 'Hello'), button('b1', 'https://evil.example/')]]);
    const original = design([[para('p1', 'Hello')]]);
    const config: PolicyConfig = {
      allowedLinkDomains: ['example.com'],
      requiredDisclaimer: { text: 'Fine print' },
      protectedBlockIds: ['p1'],
    };
    const snapshotCandidate = JSON.stringify(candidate);
    const snapshotOriginal = JSON.stringify(original);
    const first = evaluatePolicies({ candidate, original, config });
    const second = evaluatePolicies({ candidate: clone(candidate), original: clone(original), config });

    expect(JSON.stringify(candidate)).toBe(snapshotCandidate);
    expect(JSON.stringify(original)).toBe(snapshotOriginal);
    expect(second).toEqual(first);
  });
});

describe('createPolicyGate', () => {
  it('blocks on strict config and passes on the default config', () => {
    const candidate = design([[button('b1', 'https://evil.example/')]]);
    const strict: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, allowedLinkDomains: ['example.com'] };
    const baseDesign = JSON.stringify(design([[button('b1', 'https://evil.example/')]]));

    expect(createPolicyGate(strict, baseDesign).evaluate(candidate).blocked).toBe(true);
    expect(createPolicyGate(DEFAULT_POLICY_CONFIG, baseDesign).evaluate(candidate).blocked).toBe(false);
  });

  it('fails closed on a corrupt base snapshot', () => {
    const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['p1'] };
    const gate = createPolicyGate(config, 'not-json{{{');
    const outcome = gate.evaluate(design([[para('p1', 'Hello')]]));

    expect(outcome.blocked).toBe(true);
    expect(outcome.results.some((result) => result.verdict === 'UNKNOWN')).toBe(true);
  });
});
