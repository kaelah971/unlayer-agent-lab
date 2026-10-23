/**
 * Deterministic scenario runner (M6).
 *
 * Five scripted fixtures that exercise the REAL production engine
 * (proposals, diffs, policies, approval) against recording mock ports.
 *
 * Honesty contract:
 * - Every scenario is labeled simulated. Nothing here touches the live
 *   canvas, autosave, localStorage, or the editor session.
 * - A simulated PASS is a property of OUR engine logic, never proof that
 *   the live Unlayer SDK would accept a design.
 * - No randomness, no dates, no network: `runScenario` twice yields
 *   byte-identical results (covered by tests).
 */
import { approveEdit, prepareParagraphEdit, type AgentPort } from '../engine/proposals';
import { diffDesigns } from '../engine/designDiff';
import { createPolicyGate, DEFAULT_POLICY_CONFIG, type PolicyConfig } from '../engine/policies';

export type ScenarioId =
  | 'paragraph-replace'
  | 'stale-rejection'
  | 'protected-change'
  | 'unsupported-content'
  | 'duplicate-ids';

export interface ScenarioDefinition {
  id: ScenarioId;
  title: string;
  description: string;
}

export interface ScenarioOutcome {
  id: ScenarioId;
  title: string;
  /** 'pass' means the engine behaved as the fixture requires. */
  status: 'pass' | 'fail';
  summary: string;
  details: string;
  diffSummary?: string;
  policyNote?: string;
  loadDesignCalls: number;
  backupCalls: number;
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'paragraph-replace',
    title: 'Successful paragraph modification',
    description: 'A valid first-paragraph edit prepares cleanly: one collapsed diff change, policies pass.',
  },
  {
    id: 'stale-rejection',
    title: 'Stale proposal rejection',
    description: 'Approving after an external canvas change stops before backup/load with a stale outcome.',
  },
  {
    id: 'protected-change',
    title: 'Protected section modification',
    description: 'Changing an application-protected block fails the policy gate; nothing is backed up or loaded.',
  },
  {
    id: 'unsupported-content',
    title: 'Unsupported content block',
    description: 'Preparing an edit whose first block is not an editable paragraph fails closed with a clear error.',
  },
  {
    id: 'duplicate-ids',
    title: 'Duplicate block IDs',
    description: 'A diff over duplicated IDs reports the ambiguity (complete: false) instead of guessing.',
  },
];

export const SIMULATED_NOTE =
  'Simulated with a mock agent port. The live canvas, autosave, and editor session were not touched — this is not proof the live SDK would accept the design.';

/* Fixtures (local, deterministic) */

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

function image(id: string) {
  return { id, type: 'image', values: { src: 'https://example.com/y.png', alt: 'Y' } };
}

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

interface RecordingPort extends AgentPort {
  calls: { getDesign: number; loadDesign: number; backup: number };
}

function makePort(liveDesign: unknown): { port: RecordingPort; recordBackup: () => void } {
  const calls = { getDesign: 0, loadDesign: 0, backup: 0 };
  const port: RecordingPort = {
    calls,
    getDesign: async () => {
      calls.getDesign += 1;
      return structuredClone(liveDesign);
    },
    loadDesign: async () => {
      calls.loadDesign += 1;
      return { ok: true, loaded: true, errors: [], errorCount: 0 };
    },
  };
  return { port, recordBackup: () => { calls.backup += 1; } };
}

function pass(id: ScenarioId, title: string, summary: string, extra: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    id,
    title,
    status: 'pass',
    summary,
    details: SIMULATED_NOTE,
    loadDesignCalls: 0,
    backupCalls: 0,
    ...extra,
  };
}

function fail(id: ScenarioId, title: string, summary: string, extra: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    id,
    title,
    status: 'fail',
    summary,
    details: SIMULATED_NOTE,
    loadDesignCalls: 0,
    backupCalls: 0,
    ...extra,
  };
}

/* Fixture runners */

function runParagraphReplace(def: ScenarioDefinition): ScenarioOutcome {
  try {
    const prepared = prepareParagraphEdit(design([[para('p1', 'Hello')]]), 'Sale starts Friday');
    if (
      prepared.before !== 'Hello' ||
      prepared.after !== 'Sale starts Friday' ||
      prepared.diff.changes.length !== 1 ||
      prepared.policyBlocked
    ) {
      return fail(def.id, def.title, 'Proposal did not match the expected shape.');
    }
    return pass(def.id, def.title, 'Valid edit prepared: 1 collapsed change, policies pass.', {
      diffSummary: prepared.diff.summary,
      policyNote: prepared.policies.map((policy) => `${policy.ruleId}=${policy.verdict}`).join(', '),
    });
  } catch (error) {
    return fail(def.id, def.title, `Unexpected throw: ${error instanceof Error ? error.message : 'unknown'}.`);
  }
}

async function runStaleRejection(def: ScenarioDefinition): Promise<ScenarioOutcome> {
  const prepared = prepareParagraphEdit(design([[para('p1', 'Hello')]]), 'New text');
  const { port, recordBackup } = makePort(design([[para('p1', 'Someone edited meanwhile')]]));
  const outcome = await approveEdit(port, prepared, { alreadyApplying: false, backup: recordBackup });
  if (outcome.status !== 'stale') {
    return fail(def.id, def.title, `Expected a stale outcome, got "${outcome.status}".`, {
      loadDesignCalls: port.calls.loadDesign,
      backupCalls: port.calls.backup,
    });
  }
  if (port.calls.loadDesign !== 0 || port.calls.backup !== 0) {
    return fail(def.id, def.title, 'Stale approval performed I/O it should have skipped.');
  }
  return pass(def.id, def.title, 'Stale proposal rejected: changed design detected; approval stopped before backup/load.', {
    loadDesignCalls: port.calls.loadDesign,
    backupCalls: port.calls.backup,
  });
}

async function runProtectedChange(def: ScenarioDefinition): Promise<ScenarioOutcome> {
  const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, protectedBlockIds: ['brand'] };
  const original = design([[para('brand', 'Our brand'), para('p1', 'Body')]]);
  // The manual transform edits the first block, which here IS the protected
  // one — the policy gate must stop the approval before any I/O.
  const prepared = prepareParagraphEdit(original, 'Edited brand', config);
  if (!prepared.policyBlocked) {
    return fail(def.id, def.title, 'Protected change was not flagged at prepare time.');
  }
  const { port, recordBackup } = makePort(original);
  const outcome = await approveEdit(port, prepared, {
    alreadyApplying: false,
    backup: recordBackup,
    policyGate: createPolicyGate(config, prepared.baseDesign),
  });
  if (outcome.status !== 'blocked') {
    return fail(def.id, def.title, `Expected a blocked outcome, got "${outcome.status}".`, {
      loadDesignCalls: port.calls.loadDesign,
      backupCalls: port.calls.backup,
    });
  }
  return pass(def.id, def.title, 'Protected change blocked by policy before backup/load.', {
    policyNote: prepared.policies.map((policy) => `${policy.ruleId}=${policy.verdict}`).join(', '),
    loadDesignCalls: port.calls.loadDesign,
    backupCalls: port.calls.backup,
  });
}

function runUnsupportedContent(def: ScenarioDefinition): ScenarioOutcome {
  try {
    prepareParagraphEdit(design([[image('img-1')]]), 'Hi');
    return fail(def.id, def.title, 'Engine accepted an edit it should have rejected.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    if (message !== 'First content block is not an editable paragraph.') {
      return fail(def.id, def.title, `Wrong failure message: ${message}.`);
    }
    return pass(def.id, def.title, 'Unsupported first block rejected with a clear error.');
  }
}

function runDuplicateIds(def: ScenarioDefinition): ScenarioOutcome {
  const before = design([[para('dup', 'A'), para('dup', 'B')]]);
  const after = design([[para('dup', 'A'), para('dup', 'C')]]);
  const diff = diffDesigns(before, after);
  if (diff.complete) {
    return fail(def.id, def.title, 'Duplicate IDs were reported as a complete comparison.');
  }
  if (!diff.limitations.some((entry) => entry.includes('Duplicate block id "dup"'))) {
    return fail(def.id, def.title, 'Duplicate-ID limitation was not reported.');
  }
  return pass(def.id, def.title, 'Ambiguity reported instead of guessed.', { diffSummary: diff.summary });
}

/** Runs one fixture. Never touches the live editor, autosave, or storage. */
export async function runScenario(id: ScenarioId): Promise<ScenarioOutcome> {
  const def = SCENARIOS.find((scenario) => scenario.id === id);
  if (!def) throw new Error(`Unknown scenario: ${id}`);
  switch (id) {
    case 'paragraph-replace':
      return runParagraphReplace(def);
    case 'stale-rejection':
      return runStaleRejection(def);
    case 'protected-change':
      return runProtectedChange(def);
    case 'unsupported-content':
      return runUnsupportedContent(def);
    case 'duplicate-ids':
      return runDuplicateIds(def);
  }
}

/** Runs every fixture in fixed order. Deterministic: same input, same output. */
export async function runAllScenarios(): Promise<ScenarioOutcome[]> {
  const results: ScenarioOutcome[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario.id));
  }
  return results;
}
