/**
 * Copyable integration snippets (M6).
 *
 * Real, minimal Unlayer Agent API usage for developers embedding the
 * builder. Every snippet uses only documented native calls
 * (`unlayer.agent.describe/getDesign/loadDesign`) — no app internals,
 * no credentials, no network endpoints.
 */
export interface IntegrationSnippet {
  id: string;
  title: string;
  description: string;
  language: 'javascript';
  code: string;
}

export const INTEGRATION_SNIPPETS: IntegrationSnippet[] = [
  {
    id: 'describe',
    title: 'Check agent connection',
    description: 'Presence of unlayer.agent proves nothing — call describe() and count the editors it lists.',
    language: 'javascript',
    code: [
      'const { editors } = await unlayer.agent.describe();',
      "if (editors.length === 0) throw new Error('No agent-enabled editor');",
      '`Connected to ${editors.length} agent-enabled editor(s).`',
    ].join('\n'),
  },
  {
    id: 'getDesign',
    title: 'Read the current design',
    description: 'Snapshot the live design before proposing any change.',
    language: 'javascript',
    code: [
      'const design = await unlayer.agent.getDesign();',
      'const first = design.body.rows[0]?.columns?.[0]?.contents?.[0];',
      'const baseSnapshot = JSON.stringify(design);',
    ].join('\n'),
  },
  {
    id: 'approve',
    title: 'Human-approved apply with stale check',
    description: 'Re-read, compare against the proposal base, back up, then load. Never load before approval.',
    language: 'javascript',
    code: [
      'const current = await unlayer.agent.getDesign();',
      'if (JSON.stringify(current) !== proposal.baseSnapshot) {',
      "  throw new Error('Design changed - prepare a new proposal.');",
      '}',
      'localStorage.setItem("my-app:pre-approved", proposal.baseSnapshot);',
      'const result = await unlayer.agent.loadDesign(proposal.candidate);',
      'if (!result.ok || !result.loaded) {',
      '  throw new Error(result.errors.map((e) => e.message).join("; "));',
      '}',
    ].join('\n'),
  },
];
