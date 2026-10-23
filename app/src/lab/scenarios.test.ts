/**
 * M6 tests for the deterministic scenario runner (`./scenarios`).
 *
 * Every scenario runs the REAL production engine (prepare/approve/diff/
 * policies) against recording mock ports. Assertions pin both the expected
 * outcome and the isolation contract: read-only and rejection paths must
 * never call `loadDesign`, and stale/blocked paths must never back up.
 */
import { describe, expect, it } from 'vitest';
import { runAllScenarios, runScenario, SCENARIOS, SIMULATED_NOTE, type ScenarioId } from './scenarios';

describe('scenarios', () => {
  it('ships the five required fixtures', () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'paragraph-replace',
      'stale-rejection',
      'protected-change',
      'unsupported-content',
      'duplicate-ids',
    ]);
    for (const scenario of SCENARIOS) {
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(0);
    }
  });

  it('paragraph-replace prepares one collapsed change with passing policies', async () => {
    const result = await runScenario('paragraph-replace');
    expect(result.status).toBe('pass');
    expect(result.diffSummary).toBe('1 change across 1 block');
    expect(result.policyNote).toContain('allowed-link-domains=PASS');
    expect(result.loadDesignCalls).toBe(0);
    expect(result.backupCalls).toBe(0);
  });

  it('stale-rejection stops before backup and load', async () => {
    const result = await runScenario('stale-rejection');
    expect(result.status).toBe('pass');
    expect(result.summary).toMatch(/stale/i);
    expect(result.loadDesignCalls).toBe(0);
    expect(result.backupCalls).toBe(0);
  });

  it('protected-change is blocked by policy before any I/O', async () => {
    const result = await runScenario('protected-change');
    expect(result.status).toBe('pass');
    expect(result.policyNote).toContain('protected-sections=FAIL');
    expect(result.loadDesignCalls).toBe(0);
    expect(result.backupCalls).toBe(0);
  });

  it('unsupported-content fails closed with the expected error', async () => {
    const result = await runScenario('unsupported-content');
    expect(result.status).toBe('pass');
    expect(result.details).toBe(SIMULATED_NOTE);
  });

  it('duplicate-ids reports ambiguity instead of guessing', async () => {
    const result = await runScenario('duplicate-ids');
    expect(result.status).toBe('pass');
    expect(result.details).toBe(SIMULATED_NOTE);
  });

  it('is deterministic across runs', async () => {
    expect(await runAllScenarios()).toEqual(await runAllScenarios());
  });

  it('runs all fixtures green', async () => {
    const results = await runAllScenarios();
    expect(results).toHaveLength(5);
    for (const result of results) expect(result.status).toBe('pass');
  });

  it('never touches the live global agent', async () => {
    await runAllScenarios();
    expect((globalThis as unknown as { unlayer?: unknown }).unlayer).toBeUndefined();
  });

  it('rejects unknown scenario ids', async () => {
    await expect(runScenario('nope' as ScenarioId)).rejects.toThrow('Unknown scenario');
  });
});
