/**
 * M6 tests for workspace navigation (`./WorkspaceTabs`, static markup).
 * Interactivity (clicking) is covered by browser QA; these tests lock the
 * accessible contract: both tabs render, exactly one is pressed, and each
 * points at its section via aria-controls.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceTabs } from './WorkspaceTabs';

const noop = (): void => {};

function pressedCount(html: string, value: string): number {
  return html.split(`aria-pressed="${value}"`).length - 1;
}

describe('WorkspaceTabs', () => {
  it('renders both workspaces with studio pressed', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs active="studio" onChange={noop} />);
    expect(html).toContain('AI Studio');
    expect(html).toContain('Developer Lab');
    expect(html).toContain('aria-controls="workspace-studio"');
    expect(html).toContain('aria-controls="workspace-lab"');
    expect(html).toContain('<nav aria-label="Workspace">');
    expect(pressedCount(html, 'true')).toBe(1);
    expect(pressedCount(html, 'false')).toBe(1);
    // The pressed tab is AI Studio (it renders first).
    expect(html.indexOf('aria-pressed="true"')).toBeLessThan(html.indexOf('Developer Lab'));
  });

  it('moves the pressed state to Developer Lab', () => {
    const html = renderToStaticMarkup(<WorkspaceTabs active="lab" onChange={noop} />);
    expect(pressedCount(html, 'true')).toBe(1);
    expect(html.indexOf('aria-pressed="true"')).toBeGreaterThan(html.indexOf('AI Studio'));
  });
});
