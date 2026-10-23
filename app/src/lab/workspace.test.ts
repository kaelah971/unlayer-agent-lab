/**
 * M6 tests for the workspace foundation (`./workspace`).
 */
import { describe, expect, it } from 'vitest';
import { isWorkspace, workspaceLabel, WORKSPACES } from './workspace';

describe('workspace', () => {
  it('recognizes exactly the two workspaces', () => {
    expect(WORKSPACES).toEqual(['studio', 'lab']);
    expect(isWorkspace('studio')).toBe(true);
    expect(isWorkspace('lab')).toBe(true);
    expect(isWorkspace('x')).toBe(false);
    expect(isWorkspace(null)).toBe(false);
    expect(isWorkspace(undefined)).toBe(false);
  });

  it('labels workspaces for humans', () => {
    expect(workspaceLabel('studio')).toBe('AI Studio');
    expect(workspaceLabel('lab')).toBe('Developer Lab');
  });
});
