/**
 * M6 tests for the Developer Lab page (`./LabPage`, static markup).
 * Effects never run under server rendering, so this locks the honest
 * framing: read-only explorer, simulated scenarios, live-only results,
 * and the evidence warning — without touching a browser.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LabPage } from './LabPage';

const noop = (): void => {};
const noopEvidence = (): void => {};

function render(): string {
  return renderToStaticMarkup(
    <LabPage
      proposal={null}
      lastApplied={null}
      rejection={null}
      evidence={[]}
      onRecordEvidence={noopEvidence}
      onClearEvidence={noop}
    />,
  );
}

describe('LabPage', () => {
  it('renders the explorer, inspector, scenarios, evidence, and snippets sections', () => {
    const html = render();
    expect(html).toContain('API explorer');
    expect(html).toContain('Proposal inspector');
    expect(html).toContain('Live Unlayer results');
    expect(html).toContain('Scenario runner');
    expect(html).toContain('Evidence');
    expect(html).toContain('Integration snippets');
    expect(html).toContain('Check connection');
    expect(html).toContain('Load schema');
    expect(html).toContain('Read current design');
    expect(html).toContain('Run all scenarios');
    expect(html).toContain('Export evidence JSON');
    expect(html).toContain('Copy snippet');
  });

  it('labels simulation boundaries and empty states honestly', () => {
    const html = render();
    expect(html).toContain('Simulated');
    expect(html).toContain('mock agent port');
    expect(html).toContain('not proof the live SDK would accept the design');
    expect(html).toContain('No pending proposal');
    expect(html).toContain('No native results yet');
    expect(html).toContain('No evidence recorded yet');
    expect(html).toContain('may contain sensitive content');
  });
});
