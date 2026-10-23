/**
 * Shared Agent Change Inspector (M3; renders DiffView/PolicyList since M6).
 *
 * Reusable, framework-free React: renders a prepared proposal (summary,
 * change list, Approve/Discard) plus native Unlayer results. All untrusted
 * design values are rendered as text — never injected HTML.
 *
 * Data honesty labels:
 * - The change list is a LOCAL structural preview computed by
 *   `diffDesigns`. Unlayer validation and audit run only after approval.
 * - `rejection` / `NativeResultPanel` content is returned BY Unlayer from
 *   an actual `loadDesign` call. `loadDesign` applies valid changes, so it
 *   is never called to "preview" — there is no pre-approval native audit.
 */
import type { PreparedParagraphEdit } from '../engine/proposals';
import type { AgentLoadDesignResult } from '../engine/types';
import { DiffView, PolicyList } from './DiffView';

export interface ChangeInspectorProps {
  proposal: PreparedParagraphEdit;
  isApplying: boolean;
  /** Native result of a rejected `loadDesign` for this proposal, if any. */
  rejection: AgentLoadDesignResult | null;
  onApprove: () => void;
  onDiscard: () => void;
}

export function ChangeInspector({
  proposal,
  isApplying,
  rejection,
  onApprove,
  onDiscard,
}: ChangeInspectorProps) {
  const errors = rejection?.errors ?? [];

  return (
    <div>
      <h3>Proposed Change</h3>
      {proposal.source.kind === 'ai' ? (
        <p>
          <strong>AI instruction ({proposal.source.mode === 'create' ? 'Create new' : 'Edit current'}):</strong>{' '}
          {proposal.after}
        </p>
      ) : (
        <>
          <p>
            <strong>Before:</strong> {proposal.before}
          </p>
          <p>
            <strong>After:</strong> {proposal.after}
          </p>
        </>
      )}

      <DiffView diff={proposal.diff} />

      <PolicyList policies={proposal.policies} blocked={proposal.policyBlocked} />

      {rejection && (
        <div role="alert">
          <p>
            <strong>Unlayer rejected this change.</strong> Nothing on the canvas was modified.
          </p>
          {errors.length > 0 ? (
            <ul aria-label="Validation errors">
              {errors.map((error, index) => (
                <li key={`${error.code}:${error.path}:${index}`}>
                  <code>{error.path}</code> — {error.message} <code>({error.code})</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>Unlayer rejected the proposed design.</p>
          )}
        </div>
      )}

      <button type="button" disabled={isApplying || proposal.policyBlocked} onClick={onApprove}>
        {isApplying ? 'Applying...' : 'Approve Change'}
      </button>
      <button type="button" onClick={onDiscard}>
        Discard Proposal
      </button>
    </div>
  );
}

export interface NativeResultPanelProps {
  title: string;
  result: AgentLoadDesignResult;
}

/** Displays a native `loadDesign` result returned by Unlayer after approval. */
export function NativeResultPanel({ title, result }: NativeResultPanelProps) {
  const protectedElements = result.protectedElements ?? [];
  const audit = result.audit ?? null;
  const auditIssues = audit?.issues ?? [];

  return (
    <div>
      <h3>{title}</h3>
      <p>
        {result.ok && result.loaded
          ? 'Applied successfully.'
          : 'Unlayer did not apply the change.'}{' '}
        ok: {String(result.ok)} · loaded: {String(result.loaded)} · errors: {result.errorCount}
      </p>
      <p>
        <strong>Protected elements:</strong>{' '}
        {protectedElements.length > 0 ? protectedElements.join(', ') : 'None'}
      </p>
      {audit ? (
        <div>
          <p>
            <strong>Audit:</strong> {audit.status} ({audit.issueCount}{' '}
            {audit.issueCount === 1 ? 'issue' : 'issues'})
          </p>
          {auditIssues.length > 0 && (
            <ul aria-label="Audit issues">
              {auditIssues.map((issue, index) => (
                <li key={`${issue.severity}:${issue.title}:${index}`}>
                  {issue.severity} — {issue.title} — {issue.description}
                  {issue.elementId ? (
                    <span>
                      {' '}
                      <code>{issue.elementId}</code>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p>Audit unavailable for this result.</p>
      )}
    </div>
  );
}
