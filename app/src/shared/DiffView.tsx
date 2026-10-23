/**
 * Shared presentational diff/policy views (M6).
 *
 * Pure rendering over production engine results (`DesignDiff`,
 * `PolicyResult`). Used by both the AI Studio ChangeInspector and the
 * Developer Lab. All untrusted values render as text — never injected HTML.
 */
import type { DesignDiff } from '../engine/designDiff';
import type { PolicyResult } from '../engine/policies';
import type { JSX } from 'react';

function kindText(kind: string): string {
  switch (kind) {
    case 'added':
      return 'Added';
    case 'removed':
      return 'Removed';
    case 'modified':
      return 'Modified';
    case 'moved':
      return 'Moved';
    default:
      return kind;
  }
}

function verdictText(verdict: string): string {
  switch (verdict) {
    case 'PASS':
      return 'Passed';
    case 'WARN':
      return 'Warning';
    case 'FAIL':
      return 'Failed';
    case 'UNKNOWN':
      return 'Unknown';
    default:
      return verdict;
  }
}

/** Local structural preview of a proposal. Unlayer validation and audit run only after approval. */
export function DiffView({ diff }: { diff: DesignDiff }): JSX.Element {
  return (
    <>
      <h4>What changed</h4>
      <p>{diff.summary}</p>
      <p>
        {diff.counts.added} added · {diff.counts.removed} removed · {diff.counts.modified} modified ·{' '}
        {diff.counts.moved} moved
      </p>
      <p>Local structural preview. Unlayer validation and audit run only after you approve.</p>

      {diff.changes.length > 0 && (
        <ul aria-label="Design changes">
          {diff.changes.map((change, index) => (
            <li key={`${change.kind}:${change.blockId ?? 'no-id'}:${change.path}:${index}`}>
              <strong>{change.label}</strong> — {kindText(change.kind)}
              {change.blockType ? ` — ${change.blockType}` : null}
              {change.blockId ? ` “${change.blockId}”` : ' (no stable ID)'}{' '}
              <code>{change.path}</code>
              {change.before !== undefined || change.after !== undefined ? (
                <span>
                  {' '}
                  — <span>Before: {change.before ?? '—'}</span> <span>After: {change.after ?? '—'}</span>
                </span>
              ) : null}
              {change.detail ? <span> — {change.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {diff.limitations.length > 0 && (
        <div>
          <p>
            <strong>Diff limitations:</strong> this comparison may be incomplete.
          </p>
          <ul>
            {diff.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Application policy findings. Distinct from Unlayer's native validation/audit by design. */
export function PolicyList({ policies, blocked }: { policies: PolicyResult[]; blocked: boolean }): JSX.Element {
  return (
    <>
      <h4>Application policy checks</h4>
      <p>
        Checked locally before approval — separate from Unlayer&apos;s native validation and audit, which run
        only after you approve.
      </p>
      <ul aria-label="Policy checks">
        {policies.map((policy) => (
          <li key={policy.ruleId}>
            <strong>{policy.label}</strong> — {verdictText(policy.verdict)} — {policy.message}
            {policy.blockIds.length > 0 ? <span> — Blocks: {policy.blockIds.join(', ')}</span> : null}
          </li>
        ))}
      </ul>
      {blocked ? (
        <p>
          <strong>Approval blocked by application policy.</strong> Resolve the failing checks above.
        </p>
      ) : null}
    </>
  );
}
