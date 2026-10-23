/**
 * Workspace foundation (M6).
 *
 * Two workspaces share one editor and one engine: AI Studio (create/edit
 * with human approval) and Developer Lab (inspect, replay, evidence).
 * Navigation is local React state — deliberately no router library:
 * a single-page embed must not remount the Unlayer iframe on workspace
 * switches (remounting would drop editor state and break autosave).
 */

export type Workspace = 'studio' | 'lab';

export const WORKSPACES: Workspace[] = ['studio', 'lab'];

export function isWorkspace(value: unknown): value is Workspace {
  return value === 'studio' || value === 'lab';
}

export function workspaceLabel(workspace: Workspace): string {
  return workspace === 'studio' ? 'AI Studio' : 'Developer Lab';
}
