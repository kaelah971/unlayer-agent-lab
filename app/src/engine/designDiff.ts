/**
 * Structured design comparison (M3 Agent Change Inspector foundation).
 *
 * Pure TypeScript: no React, no DOM, no Unlayer global. Compares two Unlayer
 * design JSON snapshots and reports content-block changes with stable
 * locations. Directly unit-testable under Vitest in Node mode.
 *
 * Design rules (conservative by intent):
 * - Blocks are matched by stable Unlayer `id`s, never by array position.
 * - Blocks without IDs are matched by position as a best effort, and the
 *   diff is marked incomplete (`complete: false` + `limitations` entry).
 * - Duplicate IDs, unrecognized structures, and unparseable `textJson`
 *   never fail silently: they produce a limitation and `complete: false`.
 * - `textJson` (Lexical JSON) and derived HTML `text` representing the same
 *   logical edit collapse into ONE change — the inspector must not report
 *   the same keystroke twice.
 * - Moves/reorders (same id, new location, same content) are `moved`, not
 *   added + removed.
 * - `counters` are Unlayer bookkeeping and are ignored. Other non-content
 *   settings (body/row/column `values`) are NOT itemized: a positional
 *   comparison flags them via `limitations` instead of guessing.
 * - Inputs are never mutated; before/after values are truncated strings.
 */

export type ChangeKind = 'added' | 'removed' | 'modified' | 'moved';

export interface DesignChange {
  kind: ChangeKind;
  /** Stable Unlayer block id, or null when the block has none. */
  blockId: string | null;
  blockType: string | null;
  /** JSON path, e.g. `body.rows[0].columns[0].contents[1].values.href`. */
  path: string;
  /** Human-readable label, e.g. `Paragraph text` or `Button link`. */
  label: string;
  before?: string;
  after?: string;
  detail?: string;
}

export interface DesignDiff {
  changes: DesignChange[];
  counts: Record<ChangeKind, number>;
  /** One-line summary, e.g. `2 changes across 1 block` or `No changes`. */
  summary: string;
  /** False when structures were ambiguous — see `limitations`. */
  complete: boolean;
  limitations: string[];
}

const MAX_VALUE_LENGTH = 140;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(x: unknown, y: unknown): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return false;
    return x.every((item, index) => deepEqual(item, (y as unknown[])[index]));
  }
  const xRecord = x as Record<string, unknown>;
  const yRecord = y as Record<string, unknown>;
  const xKeys = Object.keys(xRecord);
  const yKeys = Object.keys(yRecord);
  if (xKeys.length !== yKeys.length) return false;
  return xKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(yRecord, key) && deepEqual(xRecord[key], yRecord[key]),
  );
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) + '…' : value;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return truncate(value);
  try {
    const json = JSON.stringify(value);
    return truncate(typeof json === 'string' ? json : String(value));
  } catch {
    return truncate(String(value));
  }
}

function prettyType(blockType: string | null): string {
  if (!blockType) return 'Block';
  const spaced = blockType.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldLabel(blockType: string | null, key: string): string {
  const name = prettyType(blockType);
  switch (key) {
    case 'text':
    case 'textJson':
      return `${name} text`;
    case 'href':
      return 'Link URL';
    case 'src':
      return 'Image source';
    case 'alt':
      return 'Alternative text';
    case 'headingType':
      return 'Heading level';
    default: {
      const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      const pretty = spaced.charAt(0).toUpperCase() + spaced.slice(1);
      return `${name} ${pretty.toLowerCase()}`;
    }
  }
}

/** Collect every `text` string in a Lexical JSON tree; null when unparseable. */
function extractLogicalText(textJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textJson);
  } catch {
    return null;
  }
  const parts: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'text' && typeof value === 'string') {
        parts.push(value);
      } else {
        collect(value);
      }
    }
  };
  collect(parsed);
  return parts.join('');
}

interface CollectedBlock {
  id: string | null;
  type: string | null;
  values: Record<string, unknown>;
  valuesMissing: boolean;
  path: string;
  parentPath: string;
  index: number;
}

export interface CollectedDesign {
  blocks: CollectedBlock[];
  limitations: string[];
  /** False if anything at all was ambiguous. */
  complete: boolean;
  /**
   * False when the design could not be enumerated at all (non-object,
   * missing body, non-array rows). Withholding content changes is then
   * safer than reporting them against an unreadable baseline.
   */
  comparable: boolean;
}

/**
 * Enumerate every content block (rows/columns/contents, plus headers and
 * footers) with stable paths. Never throws: ambiguity is reported, with
 * `complete: false` and a `limitations` entry per problem.
 */
export function collectBlocks(design: unknown, side: string): CollectedDesign {
  const blocks: CollectedBlock[] = [];
  const limitations: string[] = [];
  let complete = true;
  let comparable = true;

  const note = (message: string): void => {
    if (!limitations.includes(message)) limitations.push(message);
  };
  const incompleteness = (message: string): void => {
    complete = false;
    note(message);
  };

  const collect = (): void => {
    if (!isObject(design)) {
      comparable = false;
      incompleteness(`The ${side} design is not an object; content blocks could not be compared.`);
      return;
    }
    const body = design['body'];
    if (!isObject(body)) {
      comparable = false;
      incompleteness(`Unrecognized ${side} design structure: missing body object.`);
      return;
    }
    const sections: Array<{ rows: unknown; prefix: string }> = [{ rows: body['rows'], prefix: 'body.rows' }];
    if (body['headers'] !== undefined) sections.push({ rows: body['headers'], prefix: 'body.headers' });
    if (body['footers'] !== undefined) sections.push({ rows: body['footers'], prefix: 'body.footers' });

    for (const section of sections) {
      if (!Array.isArray(section.rows)) {
        comparable = false;
        incompleteness(`Expected an array of rows at ${section.prefix} in the ${side} design; section skipped.`);
        continue;
      }
      section.rows.forEach((row, rowIndex) => {
        if (!isObject(row)) {
          incompleteness(`Skipping non-object row at ${section.prefix}[${rowIndex}] in the ${side} design.`);
          return;
        }
        const columns = row['columns'];
        if (!Array.isArray(columns)) {
          incompleteness(`Row at ${section.prefix}[${rowIndex}] has no columns array; row skipped.`);
          return;
        }
        columns.forEach((column, columnIndex) => {
          if (!isObject(column)) {
            incompleteness(
              `Skipping non-object column at ${section.prefix}[${rowIndex}].columns[${columnIndex}].`,
            );
            return;
          }
          const parentPath = `${section.prefix}[${rowIndex}].columns[${columnIndex}].contents`;
          const contents = column['contents'];
          if (!Array.isArray(contents)) {
            incompleteness(`Column at ${parentPath} has no contents array; column skipped.`);
            return;
          }
          contents.forEach((entry, index) => {
            if (!isObject(entry)) {
              incompleteness(`Skipping non-object content at ${parentPath}[${index}].`);
              return;
            }
            const id = typeof entry['id'] === 'string' && entry['id'] ? entry['id'] : null;
            const type = typeof entry['type'] === 'string' && entry['type'] ? entry['type'] : null;
            const rawValues = entry['values'];
            const valuesMissing = !isObject(rawValues);
            if (valuesMissing) {
              incompleteness(
                `Block ${id ? `"${id}"` : `at ${parentPath}[${index}]`} has no values object; compared as empty.`,
              );
            }
            blocks.push({
              id,
              type,
              values: valuesMissing ? {} : (rawValues as Record<string, unknown>),
              valuesMissing,
              path: `${parentPath}[${index}]`,
              parentPath,
              index,
            });
          });
        });
      });
    }
  };

  collect();
  return { blocks, limitations, complete, comparable };
}

export interface BlockSummary {
  id: string | null;
  type: string | null;
  /** Top-level `values` keys present on the block. */
  valueKeys: string[];
  path: string;
  valuesMissing: boolean;
}

/**
 * Read-only structural inventory of one design for the Developer Lab.
 * Same enumeration as the diff engine; values themselves are summarized
 * (keys only), never dumped.
 */
export function inspectBlocks(design: unknown): {
  blocks: BlockSummary[];
  limitations: string[];
  complete: boolean;
} {
  const collected = collectBlocks(design, 'current');
  return {
    blocks: collected.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      valueKeys: Object.keys(block.values),
      path: block.path,
      valuesMissing: block.valuesMissing,
    })),
    limitations: collected.limitations,
    complete: collected.complete,
  };
}

/**
 * Compare two Unlayer design snapshots. Never throws on unexpected shapes:
 * anything ambiguous yields `complete: false` with a `limitations` entry.
 */
export function diffDesigns(before: unknown, after: unknown): DesignDiff {
  const collectedBefore = collectBlocks(before, 'original');
  const collectedAfter = collectBlocks(after, 'proposed');
  const limitations: string[] = [...new Set([...collectedBefore.limitations, ...collectedAfter.limitations])];
  let complete = collectedBefore.complete && collectedAfter.complete;
  // Withheld when either side cannot be enumerated at all: reporting an
  // "added" block against an unreadable baseline would be a guess.
  const comparable = collectedBefore.comparable && collectedAfter.comparable;
  const changes: DesignChange[] = [];

  const note = (message: string): void => {
    if (!limitations.includes(message)) limitations.push(message);
  };
  const incompleteness = (message: string): void => {
    complete = false;
    note(message);
  };

  const beforeBlocks = collectedBefore.blocks;
  const afterBlocks = collectedAfter.blocks;

  const groupById = (blocks: CollectedBlock[]): Map<string, CollectedBlock[]> => {
    const map = new Map<string, CollectedBlock[]>();
    for (const block of blocks) {
      if (block.id === null) continue;
      const list = map.get(block.id);
      if (list) list.push(block);
      else map.set(block.id, [block]);
    }
    return map;
  };

  const beforeById = groupById(beforeBlocks);
  const afterById = groupById(afterBlocks);

  interface Pair {
    beforeBlock: CollectedBlock;
    afterBlock: CollectedBlock;
  }
  const matched: Pair[] = [];
  const added: CollectedBlock[] = [];
  const removed: CollectedBlock[] = [];

  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const beforeList = beforeById.get(id) ?? [];
    const afterList = afterById.get(id) ?? [];
    if (beforeList.length > 1 || afterList.length > 1) {
      incompleteness(
        `Duplicate block id "${id}" (${beforeList.length} original, ${afterList.length} proposed); matched by order.`,
      );
    }
    const count = Math.max(beforeList.length, afterList.length);
    for (let k = 0; k < count; k++) {
      const beforeBlock = beforeList[k];
      const afterBlock = afterList[k];
      if (beforeBlock && afterBlock) matched.push({ beforeBlock, afterBlock });
      else if (afterBlock) added.push(afterBlock);
      else if (beforeBlock) removed.push(beforeBlock);
    }
  }

  // Blocks without stable IDs: best-effort positional pairing within the
  // same parent; always reported as a limitation.
  const groupByParent = (blocks: CollectedBlock[]): Map<string, CollectedBlock[]> => {
    const map = new Map<string, CollectedBlock[]>();
    for (const block of blocks) {
      const list = map.get(block.parentPath);
      if (list) list.push(block);
      else map.set(block.parentPath, [block]);
    }
    return map;
  };
  const orphanBefore = groupByParent(beforeBlocks.filter((block) => block.id === null));
  const orphanAfter = groupByParent(afterBlocks.filter((block) => block.id === null));
  if (orphanBefore.size > 0 || orphanAfter.size > 0) {
    incompleteness('Some blocks have no stable IDs; they were matched by position, which may be wrong.');
  }
  for (const parentPath of new Set([...orphanBefore.keys(), ...orphanAfter.keys()])) {
    const beforeList = (orphanBefore.get(parentPath) ?? []).slice().sort((x, y) => x.index - y.index);
    const afterList = (orphanAfter.get(parentPath) ?? []).slice().sort((x, y) => x.index - y.index);
    const count = Math.max(beforeList.length, afterList.length);
    for (let k = 0; k < count; k++) {
      const beforeBlock = beforeList[k];
      const afterBlock = afterList[k];
      if (beforeBlock && afterBlock) matched.push({ beforeBlock, afterBlock });
      else if (afterBlock) added.push(afterBlock);
      else if (beforeBlock) removed.push(beforeBlock);
    }
  }

  const compareValues = (pair: Pair): void => {
    const { beforeBlock, afterBlock } = pair;
    const blockId = afterBlock.id ?? beforeBlock.id;
    const blockType = afterBlock.type ?? beforeBlock.type;
    const basePath = `${afterBlock.path}.values`;

    if (afterBlock.valuesMissing || beforeBlock.valuesMissing) {
      if (!deepEqual(beforeBlock.values, afterBlock.values)) {
        changes.push({
          kind: 'modified',
          blockId,
          blockType,
          path: basePath,
          label: `${prettyType(blockType)} content`,
          before: formatValue(beforeBlock.values),
          after: formatValue(afterBlock.values),
          detail: 'Values compared as a whole because one side has no values object.',
        });
      }
      return;
    }

    if (deepEqual(beforeBlock.values, afterBlock.values)) return;

    const handled = new Set<string>();
    const textJsonBefore = beforeBlock.values['textJson'];
    const textJsonAfter = afterBlock.values['textJson'];
    const textBefore = beforeBlock.values['text'];
    const textAfter = afterBlock.values['text'];

    // Collapse textJson + HTML text into one logical change when both sides
    // carry both fields as strings. textJson is the source of truth.
    if (
      typeof textJsonBefore === 'string' &&
      typeof textJsonAfter === 'string' &&
      typeof textBefore === 'string' &&
      typeof textAfter === 'string' &&
      (textJsonBefore !== textJsonAfter || textBefore !== textAfter)
    ) {
      handled.add('textJson');
      handled.add('text');
      const logicalBefore = extractLogicalText(textJsonBefore);
      const logicalAfter = extractLogicalText(textJsonAfter);
      if (logicalBefore !== null && logicalAfter !== null) {
        if (logicalBefore !== logicalAfter) {
          changes.push({
            kind: 'modified',
            blockId,
            blockType,
            path: `${basePath}.textJson`,
            label: `${prettyType(blockType)} text`,
            before: truncate(logicalBefore),
            after: truncate(logicalAfter),
            detail: 'HTML text updated to match.',
          });
        } else if (textBefore !== textAfter) {
          changes.push({
            kind: 'modified',
            blockId,
            blockType,
            path: `${basePath}.text`,
            label: `${prettyType(blockType)} HTML text`,
            before: truncate(textBefore),
            after: truncate(textAfter),
            detail: 'Text content unchanged.',
          });
        } else {
          changes.push({
            kind: 'modified',
            blockId,
            blockType,
            path: `${basePath}.textJson`,
            label: `${prettyType(blockType)} text formatting`,
            before: truncate(textJsonBefore),
            after: truncate(textJsonAfter),
            detail: 'Text content unchanged.',
          });
        }
      } else {
        incompleteness(
          `Could not parse textJson for block ${blockId ? `"${blockId}"` : `at ${afterBlock.path}`}; showing raw values.`,
        );
        if (textJsonBefore !== textJsonAfter) {
          changes.push({
            kind: 'modified',
            blockId,
            blockType,
            path: `${basePath}.textJson`,
            label: fieldLabel(blockType, 'textJson'),
            before: formatValue(textJsonBefore),
            after: formatValue(textJsonAfter),
          });
        }
        if (textBefore !== textAfter) {
          changes.push({
            kind: 'modified',
            blockId,
            blockType,
            path: `${basePath}.text`,
            label: fieldLabel(blockType, 'text'),
            before: formatValue(textBefore),
            after: formatValue(textAfter),
          });
        }
      }
    }

    for (const key of new Set([...Object.keys(beforeBlock.values), ...Object.keys(afterBlock.values)])) {
      if (handled.has(key)) continue;
      const valueBefore = beforeBlock.values[key];
      const valueAfter = afterBlock.values[key];
      if (deepEqual(valueBefore, valueAfter)) continue;
      changes.push({
        kind: 'modified',
        blockId,
        blockType,
        path: `${basePath}.${key}`,
        label: fieldLabel(blockType, key),
        before: formatValue(valueBefore),
        after: formatValue(valueAfter),
      });
    }
  };

  // After-order first (matched + added read naturally), removals last.
  const matchedByAfterPath = new Map<string, Pair>();
  for (const pair of matched) matchedByAfterPath.set(pair.afterBlock.path, pair);
  const addedByPath = new Map<string, CollectedBlock>();
  for (const block of added) addedByPath.set(block.path, block);

  for (const block of comparable ? afterBlocks : []) {
    const pair = matchedByAfterPath.get(block.path);
    if (pair) {
      if (pair.beforeBlock.parentPath !== pair.afterBlock.parentPath || pair.beforeBlock.index !== pair.afterBlock.index) {
        changes.push({
          kind: 'moved',
          blockId: pair.afterBlock.id ?? pair.beforeBlock.id,
          blockType: pair.afterBlock.type ?? pair.beforeBlock.type,
          path: pair.afterBlock.path,
          label: `${prettyType(pair.afterBlock.type ?? pair.beforeBlock.type)} block moved`,
          detail: `Previously at ${pair.beforeBlock.path}.`,
        });
      }
      const beforeType = pair.beforeBlock.type;
      const afterType = pair.afterBlock.type;
      if (beforeType !== afterType) {
        changes.push({
          kind: 'modified',
          blockId: pair.afterBlock.id ?? pair.beforeBlock.id,
          blockType: afterType ?? beforeType,
          path: `${pair.afterBlock.path}.type`,
          label: 'Block type',
          before: beforeType ?? '—',
          after: afterType ?? '—',
        });
      }
      compareValues(pair);
      continue;
    }
    if (addedByPath.has(block.path)) {
      changes.push({
        kind: 'added',
        blockId: block.id,
        blockType: block.type,
        path: block.path,
        label: `${prettyType(block.type)} block added`,
        detail: `Added at ${block.path}.`,
      });
    }
  }
  for (const block of comparable ? beforeBlocks : []) {
    const stillPresent = matched.some((pair) => pair.beforeBlock === block);
    if (!stillPresent) {
      changes.push({
        kind: 'removed',
        blockId: block.id,
        blockType: block.type,
        path: block.path,
        label: `${prettyType(block.type)} block removed`,
        detail: `Previously at ${block.path}.`,
      });
    }
  }

  // Non-content settings (body/row/column values) are not itemized. Compare
  // positionally aligned settings only; structural row changes are already
  // covered by the block changes above. Counters are bookkeeping: ignored.
  const checkSettings = (): void => {
    if (!isObject(before) || !isObject(after)) return;
    const beforeBody = before['body'];
    const afterBody = after['body'];
    if (!isObject(beforeBody) || !isObject(afterBody)) return;
    if (!deepEqual(beforeBody['values'] ?? {}, afterBody['values'] ?? {})) {
      incompleteness('Email-level settings changed (not itemized in this diff).');
    }
    const compareRows = (rowsBefore: unknown, rowsAfter: unknown, prefix: string): void => {
      if (!Array.isArray(rowsBefore) || !Array.isArray(rowsAfter)) return;
      if (rowsBefore.length !== rowsAfter.length) return; // structural; blocks already reported
      rowsBefore.forEach((rowBefore, rowIndex) => {
        const rowAfter = (rowsAfter as unknown[])[rowIndex];
        if (!isObject(rowBefore) || !isObject(rowAfter)) return;
        if (!deepEqual(rowBefore['values'] ?? {}, rowAfter['values'] ?? {})) {
          incompleteness(`Row settings changed at ${prefix}[${rowIndex}] (not itemized in this diff).`);
        }
        const columnsBefore = rowBefore['columns'];
        const columnsAfter = rowAfter['columns'];
        if (!Array.isArray(columnsBefore) || !Array.isArray(columnsAfter)) return;
        if (columnsBefore.length !== columnsAfter.length) return;
        columnsBefore.forEach((columnBefore, columnIndex) => {
          const columnAfter = (columnsAfter as unknown[])[columnIndex];
          if (!isObject(columnBefore) || !isObject(columnAfter)) return;
          if (!deepEqual(columnBefore['values'] ?? {}, columnAfter['values'] ?? {})) {
            incompleteness(
              `Column settings changed at ${prefix}[${rowIndex}].columns[${columnIndex}] (not itemized).`,
            );
          }
        });
      });
    };
    compareRows(beforeBody['rows'], afterBody['rows'], 'body.rows');
    compareRows(beforeBody['headers'], afterBody['headers'], 'body.headers');
    compareRows(beforeBody['footers'], afterBody['footers'], 'body.footers');
  };
  if (comparable) checkSettings();

  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, modified: 0, moved: 0 };
  for (const change of changes) counts[change.kind] += 1;

  let summary: string;
  if (changes.length === 0) {
    summary = complete ? 'No changes' : 'Unable to compare designs';
  } else {
    const blocks = new Set(changes.map((change) => change.blockId ?? change.path));
    const changeWord = changes.length === 1 ? 'change' : 'changes';
    const blockWord = blocks.size === 1 ? 'block' : 'blocks';
    summary = `${changes.length} ${changeWord} across ${blocks.size} ${blockWord}`;
  }

  return { changes, counts, summary, complete, limitations };
}
