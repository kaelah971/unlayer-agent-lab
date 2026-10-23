/**
 * Developer Lab (M6).
 *
 * Read-only inspection (describe / schema / getDesign), proposal and
 * policy inspection, deterministic mock scenarios, evidence export, and
 * copyable integration snippets. Runs against the shared engine modules.
 *
 * Honesty rules enforced by this component:
 * - Live sections are labeled live; scenario sections are labeled simulated.
 * - No scenario or explorer button writes to the canvas, autosave, or storage.
 * - Native validation/audit panels render only from real `loadDesign`
 *   results recorded this session — never synthesized.
 */
import { useState } from 'react';
import { describeAgent, getAgentDesign, getAgentSchema } from '../engine/unlayerAgent';
import { inspectBlocks } from '../engine/designDiff';
import type { AgentDescription, AgentLoadDesignResult } from '../engine/types';
import type { PreparedParagraphEdit } from '../engine/proposals';
import { DiffView, PolicyList } from '../shared/DiffView';
import { NativeResultPanel } from '../shared/ChangeInspector';
import { formatEditorList, connectionHeadline, previewJson } from './apiExplorer';
import {
  runAllScenarios,
  runScenario,
  SCENARIOS,
  type ScenarioId,
  type ScenarioOutcome,
} from './scenarios';
import {
  evidenceToJson,
  EVIDENCE_EXPORT_WARNING,
  scenarioToEvidence,
  type EvidenceEntry,
} from './evidence';
import { INTEGRATION_SNIPPETS, type IntegrationSnippet } from './snippets';

export interface LabPageProps {
  proposal: PreparedParagraphEdit | null;
  lastApplied: AgentLoadDesignResult | null;
  rejection: AgentLoadDesignResult | null;
  evidence: EvidenceEntry[];
  onRecordEvidence: (entry: Omit<EvidenceEntry, 'id' | 'recordedAt'>) => void;
  onClearEvidence: () => void;
}

type FetchState<T> =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: string }
  | { status: 'unsupported'; error: string };

interface InspectedDesign {
  blockCount: number;
  blocks: Array<{ id: string | null; type: string | null; path: string; valueKeys: string[] }>;
  limitations: string[];
  complete: boolean;
  bytes: number;
  truncatedJson: string;
  truncated: boolean;
}

export function LabPage({ proposal, lastApplied, rejection, evidence, onRecordEvidence, onClearEvidence }: LabPageProps) {
  const [connection, setConnection] = useState<FetchState<AgentDescription>>({ status: 'idle' });
  const [schema, setSchema] = useState<FetchState<unknown>>({ status: 'idle' });
  const [liveDesign, setLiveDesign] = useState<FetchState<InspectedDesign>>({ status: 'idle' });
  const [scenarioResults, setScenarioResults] = useState<Partial<Record<ScenarioId, ScenarioOutcome>>>({});
  const [scenariosRunning, setScenariosRunning] = useState(false);
  const [includeDesigns, setIncludeDesigns] = useState(false);
  const [evidenceStatus, setEvidenceStatus] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const checkConnection = async (): Promise<void> => {
    setConnection({ status: 'loading' });
    try {
      const details = await describeAgent();
      setConnection({ status: 'ready', data: details });
      onRecordEvidence({
        operation: 'agent.describe',
        source: 'live',
        editorSummary: `${details.editors.length} editor(s)`,
        schemaVersion: details.schemaVersion,
        result: details.editors.length > 0 ? 'pass' : 'error',
        summary: connectionHeadline(details),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent connection failed.';
      setConnection({ status: 'error', error: message });
      onRecordEvidence({ operation: 'agent.describe', source: 'live', result: 'error', summary: message });
    }
  };

  const loadSchema = async (): Promise<void> => {
    setSchema({ status: 'loading' });
    try {
      const result = await getAgentSchema();
      setSchema({ status: 'ready', data: result });
      onRecordEvidence({ operation: 'agent.schema', source: 'live', result: 'pass', summary: 'Design JSON schema loaded.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Schema request failed.';
      if (message.includes('not supported')) {
        setSchema({ status: 'unsupported', error: message });
      } else {
        setSchema({ status: 'error', error: message });
      }
    }
  };

  const readDesign = async (): Promise<void> => {
    setLiveDesign({ status: 'loading' });
    try {
      const current = await getAgentDesign();
      const inspected = inspectBlocks(current);
      const preview = previewJson(current);
      setLiveDesign({
        status: 'ready',
        data: {
          blockCount: inspected.blocks.length,
          blocks: inspected.blocks,
          limitations: inspected.limitations,
          complete: inspected.complete,
          bytes: preview.bytes,
          truncatedJson: preview.text,
          truncated: preview.truncated,
        },
      });
      onRecordEvidence({
        operation: 'agent.getDesign',
        source: 'live',
        result: 'pass',
        summary: `Read current design: ${inspected.blocks.length} block(s).`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read the current design.';
      setLiveDesign({ status: 'error', error: message });
      onRecordEvidence({ operation: 'agent.getDesign', source: 'live', result: 'error', summary: message });
    }
  };

  const runOne = async (id: ScenarioId): Promise<void> => {
    setScenariosRunning(true);
    try {
      const result = await runScenario(id);
      setScenarioResults((previous) => ({ ...previous, [id]: result }));
      onRecordEvidence(scenarioToEvidence(result));
    } finally {
      setScenariosRunning(false);
    }
  };

  const runAll = async (): Promise<void> => {
    setScenariosRunning(true);
    try {
      const results = await runAllScenarios();
      const mapped: Partial<Record<ScenarioId, ScenarioOutcome>> = {};
      for (const result of results) {
        mapped[result.id] = result;
        onRecordEvidence(scenarioToEvidence(result));
      }
      setScenarioResults((previous) => ({ ...previous, ...mapped }));
    } finally {
      setScenariosRunning(false);
    }
  };

  const exportEvidence = async (): Promise<void> => {
    let designs: Record<string, unknown> | undefined;
    if (includeDesigns) {
      try {
        designs = { currentDesign: await getAgentDesign() };
      } catch (error) {
        setEvidenceStatus(error instanceof Error ? error.message : 'Could not read the current design.');
        return;
      }
    }
    const json = evidenceToJson(evidence, designs ? { includeDesigns: designs } : undefined);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'unlayer-lab-evidence.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setEvidenceStatus(`Exported ${evidence.length} evidence entr${evidence.length === 1 ? 'y' : 'ies'}.`);
  };

  const copySnippet = async (snippet: IntegrationSnippet): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(snippet.code);
      setCopyStatus(`${snippet.id}: copied.`);
    } catch {
      setCopyStatus(`${snippet.id}: copy failed — select the text manually.`);
    }
  };

  return (
    <div>
      <h3>API explorer</h3>
      <p>Read-only Unlayer agent operations. Nothing here modifies the canvas.</p>
      <div>
        <button type="button" onClick={() => void checkConnection()}>
          Check connection
        </button>{' '}
        <button type="button" onClick={() => void loadSchema()}>
          Load schema
        </button>{' '}
        <button type="button" onClick={() => void readDesign()}>
          Read current design
        </button>
      </div>
      {connection.status === 'ready' && (
        <div>
          <p>{connectionHeadline(connection.data)}</p>
          <ul aria-label="Agent editors">
            {formatEditorList(connection.data).map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
          <p>Content types: {connection.data.contentTypes.join(', ') || '(none reported)'}</p>
        </div>
      )}
      {connection.status === 'error' && (
        <p role="alert">Connection failed: {connection.error}</p>
      )}
      {schema.status === 'ready' && (
        <details>
          <summary>Design JSON schema ({previewJson(schema.data).bytes} bytes)</summary>
          <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {previewJson(schema.data).text}
          </pre>
        </details>
      )}
      {schema.status === 'unsupported' && <p>Schema unsupported: {schema.error}</p>}
      {schema.status === 'error' && (
        <p role="alert">Schema failed: {schema.error}</p>
      )}
      {liveDesign.status === 'ready' && (
        <div>
          <p>
            Current design: {liveDesign.data.blockCount} block(s)
            {liveDesign.data.complete ? '' : ' (comparison incomplete — see limitations)'}.
          </p>
          <ul aria-label="Design blocks">
            {liveDesign.data.blocks.map((block) => (
              <li key={block.path}>
                <code>{block.path}</code> — {block.type ?? 'unknown type'}
                {block.id ? ` “${block.id}”` : ' (no stable ID)'}
                {block.valueKeys.length > 0 ? ` — fields: ${block.valueKeys.join(', ')}` : null}
              </li>
            ))}
          </ul>
          {liveDesign.data.limitations.length > 0 && (
            <ul aria-label="Inspection limitations">
              {liveDesign.data.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>Raw design JSON ({liveDesign.data.bytes} bytes{liveDesign.data.truncated ? ', truncated' : ''})</summary>
            <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {liveDesign.data.truncatedJson}
            </pre>
          </details>
        </div>
      )}
      {liveDesign.status === 'error' && <p role="alert">Read failed: {liveDesign.error}</p>}

      <h3>Proposal inspector</h3>
      {proposal ? (
        <div>
          <p>Mirrors the AI Studio inspector for the pending proposal (same shared engine output).</p>
          <DiffView diff={proposal.diff} />
          <PolicyList policies={proposal.policies} blocked={proposal.policyBlocked} />
        </div>
      ) : (
        <p>No pending proposal. Prepare an edit in AI Studio to inspect it here.</p>
      )}

      <h3>Live Unlayer results</h3>
      {lastApplied || rejection ? (
        <div>
          {lastApplied && <NativeResultPanel title="Last applied change (live)" result={lastApplied} />}
          {rejection && <NativeResultPanel title="Last rejection (live)" result={rejection} />}
        </div>
      ) : (
        <p>No native results yet — Unlayer validation and audit exist only after a real approval attempt.</p>
      )}

      <h3>Scenario runner</h3>
      <p>
        <strong>Simulated — every scenario runs against a mock agent port.</strong> The live canvas,
        autosave, and editor session are untouched. A simulated PASS is not proof the live SDK would
        accept the design.
      </p>
      <div>
        <button type="button" onClick={() => void runAll()} disabled={scenariosRunning}>
          {scenariosRunning ? 'Running...' : 'Run all scenarios'}
        </button>
      </div>
      <ul aria-label="Scenarios">
        {SCENARIOS.map((scenario) => {
          const result = scenarioResults[scenario.id];
          return (
            <li key={scenario.id}>
              <strong>{scenario.title}</strong> — {scenario.description}{' '}
              <button type="button" onClick={() => void runOne(scenario.id)} disabled={scenariosRunning}>
                Run
              </button>
              {result && (
                <span>
                  {' '}
                  — {result.status === 'pass' ? 'Passed' : 'Failed'}: {result.summary}
                  {result.diffSummary ? ` (${result.diffSummary})` : null}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <h3>Evidence</h3>
      <p>{EVIDENCE_EXPORT_WARNING}</p>
      <div>
        <label>
          <input type="checkbox" checked={includeDesigns} onChange={(event) => setIncludeDesigns(event.target.checked)} />{' '}
          Include current canvas snapshot in export (may contain sensitive content)
        </label>
      </div>
      <div>
        <button type="button" onClick={() => void exportEvidence()}>
          Export evidence JSON
        </button>{' '}
        <button type="button" onClick={onClearEvidence}>
          Clear evidence
        </button>
      </div>
      {evidenceStatus && <p role="status">{evidenceStatus}</p>}
      {evidence.length === 0 ? (
        <p>No evidence recorded yet.</p>
      ) : (
        <ul aria-label="Evidence log">
          {evidence.map((entry) => (
            <li key={entry.id}>
              <code>{entry.recordedAt}</code> — <strong>{entry.operation}</strong> ({entry.source}) —{' '}
              {entry.result} — {entry.summary}
              {entry.diffSummary ? ` — ${entry.diffSummary}` : null}
            </li>
          ))}
        </ul>
      )}

      <h3>Integration snippets</h3>
      <p>Copyable examples using the real Unlayer Agent API — no app internals, no credentials.</p>
      {INTEGRATION_SNIPPETS.map((snippet) => (
        <div key={snippet.id}>
          <h4>{snippet.title}</h4>
          <p>{snippet.description}</p>
          <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {snippet.code}
          </pre>
          <button type="button" onClick={() => void copySnippet(snippet)}>
            Copy snippet
          </button>
        </div>
      ))}
      {copyStatus && <p role="status">{copyStatus}</p>}
    </div>
  );
}
