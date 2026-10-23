/**
 * Structured debugging evidence (M6).
 *
 * Small, serializable records of what the Lab (and Studio approvals) did:
 * operation name, timestamp, simulated-vs-live source, and minimal outcome
 * metadata. Defaults to minimal metadata — full design payloads are never
 * included unless the exporter explicitly opts in, and secrets are scrubbed
 * on the way out.
 */
import type { ScenarioOutcome } from './scenarios';

export type EvidenceSource = 'simulated' | 'live';
export type EvidenceResult = 'pass' | 'fail' | 'error' | 'info';

export interface NativeOutcomeSummary {
  ok: boolean;
  loaded: boolean;
  errorCount: number;
}

export interface EvidenceEntry {
  id: string;
  recordedAt: string;
  operation: string;
  source: EvidenceSource;
  editorSummary?: string | null;
  schemaVersion?: number | null;
  result: EvidenceResult;
  summary: string;
  diffSummary?: string;
  policyVerdict?: 'pass' | 'warn' | 'fail' | 'unknown' | 'blocked' | 'n/a';
  native?: NativeOutcomeSummary | null;
  errors?: Array<{ message: string }>;
}

let counter = 0;

export function createEvidenceEntry(
  input: Omit<EvidenceEntry, 'id' | 'recordedAt'> & Partial<Pick<EvidenceEntry, 'id' | 'recordedAt'>>,
): EvidenceEntry {
  counter += 1;
  return {
    recordedAt: new Date().toISOString(),
    ...input,
    id: input.id ?? `evt_${Date.now().toString(36)}_${counter}`,
  };
}

export const EVIDENCE_EXPORT_WARNING =
  'Developer debugging evidence. Designs may contain sensitive content: review before sharing. ' +
  'No API keys are ever included — this export only carries what the UI already displayed.';

/** Redact key-like fields and token-shaped values, recursively. */
export function sanitizeForExport(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^(unlayer_(sk|pat)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)$/.test(value)) {
      return '[redacted-secret]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeForExport);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      out[key] = /api[_-]?key|secret|token|password|authorization/i.test(key) ? '[redacted]' : sanitizeForExport(entryValue);
    }
    return out;
  }
  return value;
}

export interface EvidenceExport {
  exportedAt: string;
  generator: string;
  warning: string;
  entryCount: number;
  entries: unknown;
  designs?: unknown;
}

export function evidenceToJson(
  entries: EvidenceEntry[],
  options?: { includeDesigns?: Record<string, unknown> },
): string {
  const payload: EvidenceExport = {
    exportedAt: new Date().toISOString(),
    generator: 'unlayer-agent-lab',
    warning: EVIDENCE_EXPORT_WARNING,
    entryCount: entries.length,
    entries: sanitizeForExport(entries),
    ...(options?.includeDesigns ? { designs: sanitizeForExport(options.includeDesigns) } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

/** Converts a simulated scenario result into a loggable evidence entry (no id/timestamp yet). */
export function scenarioToEvidence(result: ScenarioOutcome): Omit<EvidenceEntry, 'id' | 'recordedAt'> {
  return {
    operation: `scenario.${result.id}`,
    source: 'simulated',
    result: result.status === 'pass' ? 'pass' : 'fail',
    summary: `${result.title}: ${result.summary}`,
    diffSummary: result.diffSummary,
    policyVerdict: result.policyNote ? (result.policyNote.includes('FAIL') ? 'fail' : 'pass') : 'n/a',
  };
}
