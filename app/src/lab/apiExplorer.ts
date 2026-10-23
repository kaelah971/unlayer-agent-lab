/**
 * API explorer helpers (M6).
 *
 * Pure formatting for the Developer Lab's read-only agent views. All live
 * contact happens in `LabPage` through the typed adapter (`describeAgent`,
 * `getAgentSchema`, `getAgentDesign`); these helpers only shape results
 * for display and are fully unit-testable.
 */
import type { AgentDescription } from '../engine/types';

/** One line per agent-enabled editor, e.g. `#0 container=editor`. */
export function formatEditorList(details: AgentDescription): string[] {
  return details.editors.map((editor) => `#${editor.index} container=${editor.containerId ?? '(none)'}`);
}

export function connectionHeadline(details: AgentDescription): string {
  const count = details.editors.length;
  return `Connected to ${count} agent-enabled editor${count === 1 ? '' : 's'}. Schema v${details.schemaVersion}.`;
}

export interface JsonPreview {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** Truncated, never-throwing JSON preview for large designs and schemas. */
export function previewJson(value: unknown, maxChars = 4000): JsonPreview {
  let text: string;
  try {
    const serialized = JSON.stringify(value, null, 2);
    text = typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return { text: 'Unserializable value.', truncated: false, bytes: 0 };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (text.length <= maxChars) return { text, truncated: false, bytes };
  return { text: `${text.slice(0, maxChars)}\n…(truncated)`, truncated: true, bytes };
}
