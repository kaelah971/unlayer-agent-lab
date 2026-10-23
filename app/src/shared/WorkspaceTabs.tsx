/**
 * Workspace navigation tabs (M6).
 *
 * Dumb buttons: the active workspace renders `aria-pressed="true"` and
 * each button points at its section via `aria-controls`. Switching never
 * unmounts the editor — sections toggle with `hidden`, so the iframe,
 * autosave listener, and canvas state survive.
 */
import type { Workspace } from '../lab/workspace';
import { workspaceLabel, WORKSPACES } from '../lab/workspace';
import type { JSX } from 'react';

export interface WorkspaceTabsProps {
  active: Workspace;
  onChange: (workspace: Workspace) => void;
}

export function WorkspaceTabs({ active, onChange }: WorkspaceTabsProps): JSX.Element {
  return (
    <nav aria-label="Workspace">
      {WORKSPACES.map((workspace) => (
        <button
          key={workspace}
          type="button"
          aria-pressed={active === workspace}
          aria-controls={`workspace-${workspace}`}
          onClick={() => onChange(workspace)}
        >
          {workspaceLabel(workspace)}
        </button>
      ))}
    </nav>
  );
}
