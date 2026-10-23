/**
 * M3 regression suite for the structured design diff (`./designDiff`).
 *
 * Node-mode Vitest, no browser. Every test exercises the real `diffDesigns`
 * function against plain design JSON fixtures — no production logic is
 * re-implemented here.
 */
import { describe, expect, it } from 'vitest';
import { diffDesigns, inspectBlocks } from './designDiff';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeRichText(text: string): string {
  return JSON.stringify({
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: 'normal', text, type: 'text', version: 1 }],
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
  return {
    id,
    type: 'paragraph',
    values: { text: `<p>${text}</p>`, textJson: makeRichText(text) },
  };
}

function image(id: string) {
  return { id, type: 'image', values: { src: 'https://example.com/y.png', alt: 'Y' } };
}

function button(id: string, text: string, href: string) {
  return { id, type: 'button', values: { text, href } };
}

/** Each inner array is the contents of one single-column row. */
function design(rows: unknown[][]): unknown {
  return designGrid(rows.map((contents) => [contents]));
}

/** Full control: rows -> columns -> contents. */
function designGrid(rows: unknown[][][]): unknown {
  return {
    counters: {},
    body: {
      rows: rows.map((columns, rowIndex) => ({
        id: `row-${rowIndex}`,
        cells: columns.map(() => 1),
        columns: columns.map((contents, columnIndex) => ({
          id: `row-${rowIndex}-col-${columnIndex}`,
          contents,
          values: {},
        })),
        values: {},
      })),
      values: {},
    },
  };
}

const clone = (value: unknown): unknown => structuredClone(value);

/* ------------------------------------------------------------------ */
/* Content changes                                                     */
/* ------------------------------------------------------------------ */

describe('diffDesigns', () => {
  it('reports no changes for identical designs', () => {
    const before = design([[para('p1', 'Hello'), button('b1', 'Buy', 'https://x')]]);
    const diff = diffDesigns(before, clone(before));

    expect(diff.changes).toEqual([]);
    expect(diff.complete).toBe(true);
    expect(diff.limitations).toEqual([]);
    expect(diff.summary).toBe('No changes');
    expect(diff.counts).toEqual({ added: 0, removed: 0, modified: 0, moved: 0 });
  });

  it('collapses a textJson + HTML text edit into one change', () => {
    const diff = diffDesigns(design([[para('p1', 'Hello')]]), design([[para('p1', 'Goodbye')]]));

    expect(diff.complete).toBe(true);
    expect(diff.changes).toHaveLength(1);
    const [change] = diff.changes;
    expect(change.kind).toBe('modified');
    expect(change.blockId).toBe('p1');
    expect(change.label).toBe('Paragraph text');
    expect(change.before).toBe('Hello');
    expect(change.after).toBe('Goodbye');
    expect(change.path).toBe('body.rows[0].columns[0].contents[0].values.textJson');
    expect(diff.summary).toBe('1 change across 1 block');
  });

  it('locates changes in later blocks without touching siblings', () => {
    const diff = diffDesigns(
      design([[para('p1', 'Hello'), para('p2', 'Keep'), para('p3', 'Keep')]]),
      design([[para('p1', 'Hello'), para('p2', 'Changed'), para('p3', 'Keep')]]),
    );

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].path).toBe('body.rows[0].columns[0].contents[1].values.textJson');
    expect(diff.changes[0].after).toBe('Changed');
  });

  it('reports added blocks with id, type, and path', () => {
    const diff = diffDesigns(design([[para('p1', 'Hello')]]), design([[para('p1', 'Hello'), image('img-9')]]));

    expect(diff.changes).toHaveLength(1);
    const [change] = diff.changes;
    expect(change.kind).toBe('added');
    expect(change.blockId).toBe('img-9');
    expect(change.blockType).toBe('image');
    expect(change.path).toBe('body.rows[0].columns[0].contents[1]');
    expect(diff.counts.added).toBe(1);
  });

  it('reports removed blocks', () => {
    const diff = diffDesigns(
      design([[para('p1', 'Hello'), image('img-9')]]),
      design([[para('p1', 'Hello')]]),
    );

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ kind: 'removed', blockId: 'img-9', blockType: 'image' });
    expect(diff.counts.removed).toBe(1);
  });

  it('summarizes mixed change types and counts', () => {
    const before = design([[para('p1', 'Hello'), button('b1', 'Buy', 'https://x')]]);
    const after = design([[para('p1', 'Hello!'), button('b1', 'Buy', 'https://y'), image('img-9')]]);
    const diff = diffDesigns(before, after);

    expect(diff.summary).toBe('3 changes across 3 blocks');
    expect(diff.counts).toEqual({ added: 1, removed: 0, modified: 2, moved: 0 });
  });

  it('reports button property changes with readable labels', () => {
    const diff = diffDesigns(
      design([[button('b1', 'Buy', 'https://x')]]),
      design([[button('b1', 'Buy', 'https://y')]]),
    );

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'modified',
      blockId: 'b1',
      label: 'Link URL',
      before: 'https://x',
      after: 'https://y',
    });
  });

  it('finds changes in nested rows and columns', () => {
    const before = design([[para('p1', 'A')], [para('p2', 'B')]]);
    const after = design([[para('p1', 'A')], [para('p2', 'C')]]);
    const diff = diffDesigns(before, after);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].path).toBe('body.rows[1].columns[0].contents[0].values.textJson');
  });

  it('detects header-section changes', () => {
    const headerRow = (text: string) => ({
      id: 'header-0',
      cells: [1],
      columns: [{ id: 'header-0-col-0', contents: [para('hp', text)], values: {} }],
      values: {},
    });
    const withHeader = (text: string): unknown => {
      const base = design([[para('p1', 'Body')]]) as {
        body: { headers: unknown[] };
      };
      base.body.headers = [headerRow(text)];
      return base;
    };
    const diff = diffDesigns(withHeader('Top'), withHeader('Top!'));

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].path).toBe('body.headers[0].columns[0].contents[0].values.textJson');
  });

  it('distinguishes reorders from deletions', () => {
    const first = para('p1', 'First');
    const second = para('p2', 'Second');
    const diff = diffDesigns(design([[first, second]]), design([[clone(second), clone(first)]]));

    expect(diff.counts).toEqual({ added: 0, removed: 0, modified: 0, moved: 2 });
    expect(diff.changes.map((change) => change.blockId).sort()).toEqual(['p1', 'p2']);
  });

  it('reports moves across columns with the previous location', () => {
    const before = designGrid([[[para('p1', 'Stay')], [para('p2', 'Go')]]]);
    const after = designGrid([[[para('p1', 'Stay'), para('p2', 'Go')], []]]);
    const diff = diffDesigns(before, after);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'moved',
      blockId: 'p2',
      path: 'body.rows[0].columns[0].contents[1]',
    });
    expect(diff.changes[0].detail).toContain('body.rows[0].columns[1].contents[0]');
  });

  it('matches blocks without IDs by position and marks the diff incomplete', () => {
    const noId = (text: string) => ({ type: 'paragraph', values: { text, textJson: makeRichText(text) } });
    const diff = diffDesigns(design([[noId('Hello')]]), design([[noId('Hello!')]]));

    expect(diff.complete).toBe(false);
    expect(diff.limitations.length).toBeGreaterThan(0);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].blockId).toBeNull();
  });

  it('flags duplicate IDs as incomplete instead of guessing', () => {
    const before = design([[para('dup', 'One'), para('dup', 'Two')]]);
    const after = design([[para('dup', 'One'), para('dup', 'Two!')]]);
    const diff = diffDesigns(before, after);

    expect(diff.complete).toBe(false);
    expect(diff.limitations.some((entry) => entry.includes('Duplicate block id "dup"'))).toBe(true);
  });

  it('refuses to compare ambiguous structures as complete', () => {
    for (const ambiguous of [null, undefined, 42, {}, { body: null }]) {
      const diff = diffDesigns(ambiguous, design([[para('p1', 'Hi')]]));
      expect(diff.complete).toBe(false);
      expect(diff.changes).toEqual([]);
      expect(diff.limitations.length).toBeGreaterThan(0);
    }
  });

  it('marks row settings changes as a limitation without itemizing', () => {
    const before = design([[para('p1', 'Hello')]]) as {
      body: { rows: Array<{ values: Record<string, unknown> }> };
    };
    const after = clone(before) as typeof before;
    after.body.rows[0].values = { backgroundColor: '#ff0000' };
    const diff = diffDesigns(before, after);

    expect(diff.changes).toEqual([]);
    expect(diff.complete).toBe(false);
    expect(diff.summary).toBe('Unable to compare designs');
    expect(diff.limitations.some((entry) => entry.includes('Row settings'))).toBe(true);
  });

  it('reports a block type change on the same id', () => {
    const before = design([[para('p1', 'Hello')]]);
    const after = design([[{ id: 'p1', type: 'heading', values: { text: 'Hello' } }]]);
    const diff = diffDesigns(before, after);

    expect(diff.changes.some((change) => change.label === 'Block type')).toBe(true);
  });

  it('truncates very long values', () => {
    const long = 'x'.repeat(600);
    const diff = diffDesigns(design([[para('p1', 'Hello')]]), design([[para('p1', long)]]));

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].after?.length).toBeLessThanOrEqual(141);
    expect(diff.changes[0].after?.endsWith('…')).toBe(true);
  });

  it('falls back to raw values when textJson cannot be parsed', () => {
    const broken = design([[para('p1', 'Hello')]]) as {
      body: { rows: Array<{ columns: Array<{ contents: Array<{ values: { textJson: string } }> }> }> };
    };
    broken.body.rows[0].columns[0].contents[0].values.textJson = 'broken{{{';
    const diff = diffDesigns(design([[para('p1', 'Hello')]]), broken);

    expect(diff.complete).toBe(false);
    expect(diff.limitations.some((entry) => entry.includes('Could not parse textJson'))).toBe(true);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].path).toContain('textJson');
  });

  it('never mutates its inputs', () => {
    const before = design([[para('p1', 'Hello'), image('img-9')]]);
    const after = design([[para('p1', 'Changed')]]);
    const snapshotBefore = JSON.stringify(before);
    const snapshotAfter = JSON.stringify(after);

    diffDesigns(before, after);

    expect(JSON.stringify(before)).toBe(snapshotBefore);
    expect(JSON.stringify(after)).toBe(snapshotAfter);
  });
});

describe('inspectBlocks', () => {
  it('lists blocks with ids, types, paths, and value fields', () => {
    const inspected = inspectBlocks(design([[para('p1', 'Hello'), image('img-9')]]));
    expect(inspected.complete).toBe(true);
    expect(inspected.limitations).toEqual([]);
    expect(inspected.blocks).toHaveLength(2);
    expect(inspected.blocks[0]).toMatchObject({
      id: 'p1',
      type: 'paragraph',
      path: 'body.rows[0].columns[0].contents[0]',
    });
    expect(inspected.blocks[0].valueKeys).toEqual(expect.arrayContaining(['text', 'textJson']));
    expect(inspected.blocks[1].id).toBe('img-9');
  });

  it('flags missing values objects and uninspectable designs', () => {
    const noValues = design([[{ id: 'x1', type: 'paragraph' }]]);
    const inspected = inspectBlocks(noValues);
    expect(inspected.complete).toBe(false);
    expect(inspected.blocks[0].valuesMissing).toBe(true);
    expect(inspectBlocks(null)).toEqual({ blocks: [], limitations: expect.any(Array), complete: false });
    expect(inspectBlocks(null).limitations.length).toBeGreaterThan(0);
  });
});
