/**
 * M6 tests for integration snippets (`./snippets`) and API explorer
 * helpers (`./apiExplorer`).
 */
import { describe, expect, it } from 'vitest';
import { INTEGRATION_SNIPPETS } from './snippets';
import { connectionHeadline, formatEditorList, previewJson } from './apiExplorer';
import type { AgentDescription } from '../engine/types';

function describeFixture(): AgentDescription {
  return {
    guide: 'guide',
    editors: [
      { index: 0, containerId: 'editor', version: '1.0.0' },
      { index: 1, containerId: null, version: undefined },
    ],
    editor: 0,
    displayMode: 'email',
    designMode: 'live',
    schemaVersion: 28,
    contentTypes: ['paragraph', 'button'],
    customTools: [],
    mergeTags: [],
    fonts: [],
  };
}

describe('INTEGRATION_SNIPPETS', () => {
  it('covers describe, read, and safe approval with real APIs', () => {
    expect(INTEGRATION_SNIPPETS.map((snippet) => snippet.id)).toEqual(['describe', 'getDesign', 'approve']);
    const all = INTEGRATION_SNIPPETS.map((snippet) => snippet.code).join('\n');
    expect(all).toContain('unlayer.agent.describe()');
    expect(all).toContain('unlayer.agent.getDesign()');
    expect(all).toContain('unlayer.agent.loadDesign(');
    for (const snippet of INTEGRATION_SNIPPETS) {
      expect(snippet.title.length).toBeGreaterThan(0);
      expect(snippet.description.length).toBeGreaterThan(0);
      expect(snippet.language).toBe('javascript');
    }
  });

  it('never embeds endpoints or credentials', () => {
    const all = INTEGRATION_SNIPPETS.map((snippet) => snippet.code).join('\n');
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toMatch(/unlayer_(sk|pat)_/i);
    expect(all).not.toMatch(/api[_-]?key|secret|token|bearer|authorization/i);
  });
});

describe('apiExplorer helpers', () => {
  it('formats editor lists and headlines', () => {
    expect(formatEditorList(describeFixture())).toEqual(['#0 container=editor', '#1 container=(none)']);
    expect(connectionHeadline(describeFixture())).toBe('Connected to 2 agent-enabled editors. Schema v28.');
    expect(connectionHeadline({ ...describeFixture(), editors: [describeFixture().editors[0]] })).toBe(
      'Connected to 1 agent-enabled editor. Schema v28.',
    );
  });

  it('previews JSON with truncation metadata', () => {
    const small = previewJson({ a: 1 });
    expect(small.truncated).toBe(false);
    expect(small.bytes).toBeGreaterThan(0);
    expect(small.text).toContain('"a": 1');

    const big = previewJson({ big: 'x'.repeat(10000) }, 100);
    expect(big.truncated).toBe(true);
    expect(big.text.endsWith('(truncated)')).toBe(true);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(previewJson(circular).text).toBe('Unserializable value.');
  });
});
