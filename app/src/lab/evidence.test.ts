/**
 * M6 tests for evidence records and exports (`./evidence`).
 */
import { describe, expect, it } from 'vitest';
import {
  createEvidenceEntry,
  evidenceToJson,
  EVIDENCE_EXPORT_WARNING,
  sanitizeForExport,
  scenarioToEvidence,
  type EvidenceEntry,
} from './evidence';

function entry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return createEvidenceEntry({
    operation: 'scenario.paragraph-replace',
    source: 'simulated',
    result: 'pass',
    summary: 'Valid edit prepared.',
    ...overrides,
  });
}

describe('createEvidenceEntry', () => {
  it('assigns id and timestamp by default', () => {
    const first = entry();
    const second = entry();
    expect(first.id).toMatch(/^evt_/);
    expect(first.id).not.toBe(second.id);
    expect(Date.parse(first.recordedAt)).not.toBeNaN();
  });

  it('honors explicit id and timestamp', () => {
    const fixed = entry({ id: 'evt_test', recordedAt: '2026-01-01T00:00:00.000Z' });
    expect(fixed.id).toBe('evt_test');
    expect(fixed.recordedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sanitizeForExport', () => {
  it('redacts key fields and token-shaped values', () => {
    expect(
      sanitizeForExport({
        api_key: 'anything',
        nested: { token: 'abc', note: 'Enter your token below' },
        list: ['unlayer_sk_abcdef123456', 'plain text'],
        count: 3,
      }),
    ).toEqual({
      api_key: '[redacted]',
      nested: { token: '[redacted]', note: 'Enter your token below' },
      list: ['[redacted-secret]', 'plain text'],
      count: 3,
    });
  });

  it('leaves ordinary prose untouched', () => {
    expect(sanitizeForExport('Hello world')).toBe('Hello world');
    expect(sanitizeForExport(null)).toBeNull();
  });
});

describe('evidenceToJson', () => {
  it('exports minimal metadata with a sensitive-content warning', () => {
    const parsed = JSON.parse(evidenceToJson([entry(), entry()])) as {
      warning: string;
      entryCount: number;
      generator: string;
      entries: unknown[];
    };
    expect(parsed.generator).toBe('unlayer-agent-lab');
    expect(parsed.warning).toBe(EVIDENCE_EXPORT_WARNING);
    expect(parsed.entryCount).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect('designs' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toMatch(/unlayer_sk_/);
  });

  it('attaches sanitized snapshots only when asked', () => {
    const withDesigns = JSON.parse(
      evidenceToJson([entry()], { includeDesigns: { current: { apiKey: 'x', body: {} } } }),
    ) as { designs: { current: { apiKey: string } } };
    expect(withDesigns.designs.current.apiKey).toBe('[redacted]');
  });
});

describe('scenarioToEvidence', () => {
  it('maps simulated outcomes to loggable entries', () => {
    const mapped = scenarioToEvidence({
      id: 'paragraph-replace',
      title: 'Successful paragraph modification',
      status: 'pass',
      summary: 'Valid edit prepared.',
      details: 'simulated',
      loadDesignCalls: 0,
      backupCalls: 0,
      diffSummary: '1 change across 1 block',
      policyNote: 'allowed-link-domains=PASS',
    });
    expect(mapped).toMatchObject({
      operation: 'scenario.paragraph-replace',
      source: 'simulated',
      result: 'pass',
    });
    expect(mapped.diffSummary).toBe('1 change across 1 block');
  });
});
