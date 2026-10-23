/**
 * Application policy engine (M4).
 *
 * Pure TypeScript: no React, no DOM, no Unlayer global. Evaluates a proposed
 * design against small, configurable, application-level rules and returns
 * structured verdicts. This is NOT a replacement for Unlayer's native
 * validation or audit — it answers "does this proposal meet OUR app's
 * rules?" before anything is submitted, while native results only exist
 * after `loadDesign` runs.
 *
 * Decision rules (conservative by intent):
 * - `FAIL` blocks approval (the proposal violates a configured rule).
 * - `WARN` permits approval with a visible explanation (advisory only).
 * - `UNKNOWN` blocks approval (fail-closed): the engine could not verify
 *   the rule, so it must not claim PASS. Resolve the ambiguity (fix the
 *   design or narrow the config) to proceed.
 * - Rules that enforce allowlists fail closed on missing or ambiguous
 *   data. The single advisory rule reports only what it can verify and
 *   notes what it skipped, so default-config users are never blocked by
 *   ordinary content.
 * - Inputs are never mutated; evaluation is deterministic (no I/O, no
 *   randomness, no dates). Each rule is guarded so a bug becomes
 *   `UNKNOWN`, never a false `PASS`.
 */
import { diffDesigns, type DesignDiff } from './designDiff';

export type PolicyVerdict = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface PolicyResult {
  ruleId: string;
  label: string;
  verdict: PolicyVerdict;
  message: string;
  blockIds: string[];
  paths: string[];
}

export interface PolicyConfig {
  /** Exact-match allowed hosts for button URLs (lowercase comparison, no wildcards). Empty = no restriction. */
  allowedLinkDomains: string[];
  /** Required disclaimer: satisfied by matching text OR block identity. Null = not required. */
  requiredDisclaimer: { text?: string; blockId?: string } | null;
  /** Application-protected block IDs: must be unchanged, present, and unmoved. Empty = none. */
  protectedBlockIds: string[];
}

/**
 * Permissive defaults: every rule passes vacuously, so existing users and
 * the manual demo flow are never blocked until policies are configured.
 */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  allowedLinkDomains: [],
  requiredDisclaimer: null,
  protectedBlockIds: [],
};

export interface PolicyEvaluation {
  results: PolicyResult[];
  /** True when any result is FAIL or UNKNOWN. */
  blocked: boolean;
  /** False when any result is UNKNOWN. */
  complete: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface FoundBlock {
  id: string | null;
  type: string | null;
  values: Record<string, unknown>;
  path: string;
}

/**
 * Defensive block walk. Tolerates hostile shapes (never throws); reports
 * whether the top-level structure was usable and whether any nested entry
 * had to be skipped, so rules can answer UNKNOWN instead of guessing.
 */
function walkBlocks(design: unknown): { blocks: FoundBlock[]; structureOk: boolean; skipped: boolean } {
  const blocks: FoundBlock[] = [];
  let skipped = false;
  if (!isObject(design)) return { blocks, structureOk: false, skipped };
  const body = design['body'];
  if (!isObject(body)) return { blocks, structureOk: false, skipped };
  const sections: Array<{ rows: unknown; prefix: string }> = [{ rows: body['rows'], prefix: 'body.rows' }];
  if (body['headers'] !== undefined) sections.push({ rows: body['headers'], prefix: 'body.headers' });
  if (body['footers'] !== undefined) sections.push({ rows: body['footers'], prefix: 'body.footers' });
  for (const section of sections) {
    if (!Array.isArray(section.rows)) return { blocks, structureOk: false, skipped };
    section.rows.forEach((row, rowIndex) => {
      if (!isObject(row)) {
        skipped = true;
        return;
      }
      const columns = row['columns'];
      if (!Array.isArray(columns)) {
        skipped = true;
        return;
      }
      columns.forEach((column, columnIndex) => {
        if (!isObject(column)) {
          skipped = true;
          return;
        }
        const contents = column['contents'];
        if (!Array.isArray(contents)) {
          skipped = true;
          return;
        }
        contents.forEach((entry, index) => {
          if (!isObject(entry)) {
            skipped = true;
            return;
          }
          const id = typeof entry['id'] === 'string' && entry['id'] ? entry['id'] : null;
          const type = typeof entry['type'] === 'string' && entry['type'] ? entry['type'] : null;
          blocks.push({
            id,
            type,
            values: isObject(entry['values']) ? entry['values'] : {},
            path: `${section.prefix}[${rowIndex}].columns[${columnIndex}].contents[${index}]`,
          });
        });
      });
    });
  }
  return { blocks, structureOk: true, skipped };
}

function collectTextNodes(node: unknown, parts: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTextNodes(item, parts);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' && typeof value === 'string') parts.push(value);
    else collectTextNodes(value, parts);
  }
}

/** Button hrefs may be a plain string or Unlayer's `{ name, values: { href, target } }` shape. */
function readButtonLink(values: Record<string, unknown>): { href: unknown; target: unknown } {
  const direct = values['href'];
  if (typeof direct === 'string' || direct === undefined) {
    return { href: direct, target: values['target'] };
  }
  if (isObject(direct)) {
    const inner = isObject(direct['values']) ? direct['values'] : direct;
    return { href: inner['href'], target: inner['target'] };
  }
  return { href: undefined, target: undefined };
}

type DomainAssessment =
  | { status: 'ok'; host: string }
  | { status: 'denied'; host: string }
  | { status: 'unknown'; reason: string };

function assessDomain(href: unknown, allowed: string[]): DomainAssessment {
  if (typeof href !== 'string' || href.trim() === '') {
    return { status: 'unknown', reason: 'missing or empty URL' };
  }
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return { status: 'unknown', reason: `not an absolute URL: "${href.trim().slice(0, 80)}"` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { status: 'unknown', reason: `unsupported protocol "${url.protocol}"` };
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const normalized = allowed.map((domain) => domain.trim().toLowerCase().replace(/\.+$/, ''));
  if (normalized.includes(host)) return { status: 'ok', host };
  return { status: 'denied', host };
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function linkDomainsRule(candidate: unknown, config: PolicyConfig): PolicyResult {
  const base = {
    ruleId: 'allowed-link-domains',
    label: 'Allowed link domains',
    blockIds: [] as string[],
    paths: [] as string[],
  };
  if (config.allowedLinkDomains.length === 0) {
    return { ...base, verdict: 'PASS', message: 'No domain restriction configured.' };
  }
  const { blocks, structureOk, skipped } = walkBlocks(candidate);
  if (!structureOk) {
    return { ...base, verdict: 'UNKNOWN', message: 'Could not enumerate content blocks; links cannot be verified.' };
  }
  const denied: Array<{ id: string; host: string }> = [];
  const unknown: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'button') continue;
    const { href } = readButtonLink(block.values);
    const assessment = assessDomain(href, config.allowedLinkDomains);
    if (assessment.status === 'denied') {
      denied.push({ id: block.id ?? block.path, host: assessment.host });
      if (block.id) base.blockIds.push(block.id);
      base.paths.push(block.path);
    } else if (assessment.status === 'unknown') {
      unknown.push(`${block.id ?? block.path} (${assessment.reason})`);
      if (block.id) base.blockIds.push(block.id);
      base.paths.push(block.path);
    }
  }
  if (denied.length > 0) {
    const deniedHosts = [...new Set(denied.map((entry) => entry.host))];
    return {
      ...base,
      verdict: 'FAIL',
      message: `Links to disallowed domains (${deniedHosts.join(', ')}): ${denied.map((entry) => entry.id).join(', ')}. Allowed: ${config.allowedLinkDomains.join(', ')}.`,
    };
  }
  if (unknown.length > 0) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      message: `Could not verify link domains for: ${unknown.join('; ')}. Missing or ambiguous URLs never pass silently.`,
    };
  }
  if (skipped) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      message: 'Some content could not be inspected; link verification is incomplete.',
    };
  }
  return { ...base, verdict: 'PASS', message: 'All button links use allowed domains.' };
}

function disclaimerRule(candidate: unknown, config: PolicyConfig): PolicyResult {
  const base = {
    ruleId: 'required-disclaimer',
    label: 'Required disclaimer',
    blockIds: [] as string[],
    paths: [] as string[],
  };
  const requirement = config.requiredDisclaimer;
  if (!requirement || (!requirement.text && !requirement.blockId)) {
    return { ...base, verdict: 'PASS', message: 'No disclaimer required.' };
  }
  const { blocks, structureOk, skipped } = walkBlocks(candidate);
  if (!structureOk) {
    return { ...base, verdict: 'UNKNOWN', message: 'Could not enumerate content blocks; disclaimer cannot be verified.' };
  }
  let unparseable = 0;
  const texts: string[] = [];
  for (const block of blocks) {
    const text = block.values['text'];
    if (typeof text === 'string') texts.push(text);
    const textJson = block.values['textJson'];
    if (typeof textJson === 'string') {
      try {
        const parts: string[] = [];
        collectTextNodes(JSON.parse(textJson) as unknown, parts);
        if (parts.length > 0) texts.push(parts.join(''));
      } catch {
        unparseable += 1;
      }
    }
  }
  const satisfied: string[] = [];
  if (requirement.text && texts.some((text) => text.includes(requirement.text as string))) {
    satisfied.push(`matching text "${requirement.text}"`);
  }
  if (requirement.blockId) {
    const found = blocks.find((block) => block.id === requirement.blockId);
    if (found) {
      satisfied.push(`block "${requirement.blockId}"`);
      base.blockIds.push(found.id as string);
      base.paths.push(found.path);
    }
  }
  if (satisfied.length > 0) {
    return { ...base, verdict: 'PASS', message: `Disclaimer requirement satisfied by ${satisfied.join(' and ')}.` };
  }
  if (unparseable > 0 || skipped) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      message: 'Disclaimer text not found, but some content could not be fully inspected.',
    };
  }
  return { ...base, verdict: 'FAIL', message: 'Required disclaimer is missing from the design.' };
}

function protectedSectionsRule(
  candidate: unknown,
  original: unknown,
  diff: DesignDiff | undefined,
  config: PolicyConfig,
): PolicyResult {
  const base = {
    ruleId: 'protected-sections',
    label: 'Protected sections',
    blockIds: [] as string[],
    paths: [] as string[],
  };
  if (config.protectedBlockIds.length === 0) {
    return { ...base, verdict: 'PASS', message: 'No application-protected sections configured.' };
  }
  if (original === undefined) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      blockIds: [...config.protectedBlockIds],
      message: 'Original design unavailable; protected sections cannot be verified.',
    };
  }
  const comparison = diff ?? diffDesigns(original, candidate);
  const findings: Array<{ verdict: PolicyVerdict; message: string }> = [];
  for (const id of config.protectedBlockIds) {
    const ops = comparison.changes.filter((change) => change.blockId === id);
    const removed = ops.some((op) => op.kind === 'removed');
    const moved = ops.some((op) => op.kind === 'moved');
    const modified = ops.some((op) => op.kind === 'modified');
    const added = ops.some((op) => op.kind === 'added');
    base.paths.push(...ops.map((op) => op.path));
    if (removed) {
      if (comparison.complete) {
        findings.push({ verdict: 'FAIL', message: `protected block "${id}" was removed` });
        base.blockIds.push(id);
      } else {
        findings.push({ verdict: 'UNKNOWN', message: `protected block "${id}" may have been removed (comparison incomplete)` });
        base.blockIds.push(id);
      }
    } else if (moved) {
      findings.push({ verdict: 'FAIL', message: `protected block "${id}" was moved` });
      base.blockIds.push(id);
    } else if (modified) {
      findings.push({ verdict: 'FAIL', message: `protected block "${id}" was changed` });
      base.blockIds.push(id);
    } else if (added) {
      findings.push({ verdict: 'WARN', message: `protected block id "${id}" appeared in the proposal (was absent before)` });
      base.blockIds.push(id);
    } else if (!comparison.complete && comparison.limitations.some((entry) => entry.includes('Duplicate'))) {
      findings.push({ verdict: 'UNKNOWN', message: `protected block "${id}" cannot be reliably verified (duplicate IDs)` });
      base.blockIds.push(id);
    }
    // No ops and a usable comparison: the block is present and unchanged.
  }
  const originalWalk = walkBlocks(original);
  for (const id of config.protectedBlockIds) {
    if (findings.some((finding) => finding.message.includes(`"${id}"`))) continue;
    if (!originalWalk.structureOk || !originalWalk.blocks.some((block) => block.id === id)) {
      findings.push({ verdict: 'WARN', message: `protected block id "${id}" not found in the original design` });
    }
  }
  const worst: PolicyVerdict = findings.some((finding) => finding.verdict === 'FAIL')
    ? 'FAIL'
    : findings.some((finding) => finding.verdict === 'UNKNOWN')
      ? 'UNKNOWN'
      : findings.some((finding) => finding.verdict === 'WARN')
        ? 'WARN'
        : 'PASS';
  if (worst === 'PASS') {
    return { ...base, verdict: 'PASS', message: 'All protected sections are unchanged.' };
  }
  return { ...base, verdict: worst, message: `Protected section issues: ${findings.map((finding) => finding.message).join('; ')}.` };
}

function externalLinkTargetRule(candidate: unknown, config: PolicyConfig): PolicyResult {
  const base = {
    ruleId: 'external-link-target',
    label: 'External link target',
    blockIds: [] as string[],
    paths: [] as string[],
  };
  const { blocks, structureOk, skipped } = walkBlocks(candidate);
  if (!structureOk) {
    return { ...base, verdict: 'UNKNOWN', message: 'Could not enumerate content blocks; link targets cannot be checked.' };
  }
  const warnings: string[] = [];
  let checked = 0;
  let skippedCount = 0;
  for (const block of blocks) {
    if (block.type !== 'button') continue;
    const { href, target } = readButtonLink(block.values);
    if (typeof href !== 'string' || href.trim() === '') {
      skippedCount += 1;
      continue;
    }
    let host: string | null;
    try {
      const url = new URL(href.trim());
      host = url.protocol === 'http:' || url.protocol === 'https:'
        ? url.hostname.toLowerCase().replace(/\.+$/, '')
        : null;
    } catch {
      host = null;
    }
    if (host === null) {
      skippedCount += 1;
      continue;
    }
    const allowed = config.allowedLinkDomains.map((domain) => domain.trim().toLowerCase().replace(/\.+$/, ''));
    const isExternal = allowed.length === 0 || !allowed.includes(host);
    if (!isExternal) continue;
    checked += 1;
    if (target !== '_blank') {
      warnings.push(block.id ?? block.path);
      if (block.id) base.blockIds.push(block.id);
      base.paths.push(block.path);
    }
  }
  if (warnings.length > 0) {
    return {
      ...base,
      verdict: 'WARN',
      message: `External links should open in a new tab: ${warnings.join(', ')}.${skippedCount > 0 ? ` ${skippedCount} link(s) skipped (relative or non-web URL).` : ''}`,
    };
  }
  if (skipped) {
    return { ...base, verdict: 'UNKNOWN', message: 'Some content could not be inspected; link targets are unverified.' };
  }
  return {
    ...base,
    verdict: 'PASS',
    message:
      checked === 0
        ? `No external links to check.${skippedCount > 0 ? ` ${skippedCount} link(s) skipped (relative or non-web URL).` : ''}`
        : `All ${checked} external link(s) open in a new tab.${skippedCount > 0 ? ` ${skippedCount} link(s) skipped (relative or non-web URL).` : ''}`,
  };
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export function evaluatePolicies(input: {
  candidate: unknown;
  original?: unknown;
  diff?: DesignDiff;
  config?: PolicyConfig;
}): PolicyEvaluation {
  const config = input.config ?? DEFAULT_POLICY_CONFIG;
  const results: PolicyResult[] = [];
  const run = (label: string, ruleId: string, fn: () => PolicyResult): void => {
    try {
      results.push(fn());
    } catch (error) {
      results.push({
        ruleId,
        label,
        verdict: 'UNKNOWN',
        message: `Evaluation failed and was not assumed safe: ${error instanceof Error ? error.message : 'unknown error'}.`,
        blockIds: [],
        paths: [],
      });
    }
  };
  run('Allowed link domains', 'allowed-link-domains', () => linkDomainsRule(input.candidate, config));
  run('Required disclaimer', 'required-disclaimer', () => disclaimerRule(input.candidate, config));
  run('Protected sections', 'protected-sections', () =>
    protectedSectionsRule(input.candidate, input.original, input.diff, config),
  );
  run('External link target', 'external-link-target', () => externalLinkTargetRule(input.candidate, config));

  return {
    results,
    blocked: results.some((result) => result.verdict === 'FAIL' || result.verdict === 'UNKNOWN'),
    complete: !results.some((result) => result.verdict === 'UNKNOWN'),
  };
}

export interface PolicyGate {
  evaluate: (candidate: unknown) => { blocked: boolean; results: PolicyResult[] };
}

/**
 * Approval-time recheck: re-evaluates the candidate against the (possibly
 * newer) config and the proposal's base snapshot. The base snapshot may be
 * corrupt (storage tampering); unparseable bases become `undefined`, which
 * the protected-sections rule answers with UNKNOWN — fail-closed.
 */
export function createPolicyGate(config: PolicyConfig, baseDesign: string): PolicyGate {
  return {
    evaluate: (candidate) => {
      let original: unknown;
      try {
        original = JSON.parse(baseDesign) as unknown;
      } catch {
        original = undefined;
      }
      const evaluation = evaluatePolicies({ candidate, original, config });
      return { blocked: evaluation.blocked, results: evaluation.results };
    },
  };
}
