/**
 * Minimal shared engine types for M1.
 *
 * These are re-exports of the real Unlayer SDK types — not invented shapes.
 * The SDK surface was verified against the installed `react-email-editor`
 * dependency tree before M1:
 *
 * - `react-email-editor@2.1.3` depends on `@unlayer/types` (^1.448.0,
 *   installed 1.526.0) and its `dist/index.d.ts` declares the global
 *   `const unlayer: UnlayerEmbed`, where `UnlayerEmbed.agent: AgentApi`.
 * - `AgentApi` (`describe` / `schema` / `getDesign` / `loadDesign` /
 *   `exportHtml` / `preview`), `AgentDescription`, `AgentLoadDesignResult`
 *   (with full `errors: AgentDesignIssue[]`, `protectedElements?` and
 *   `audit?`), and `JSONTemplate` all come from `@unlayer/types`.
 * - `JSONTemplate` reaches the package root via
 *   `editor/design.d.ts`, which re-exports it from `../design`.
 *
 * Assumption (documented): `@unlayer/types` is currently a transitive
 * dependency (hoisted to `app/node_modules`), not a direct entry in
 * `app/package.json`. These type-only imports add no runtime dependency,
 * but a future milestone should promote `@unlayer/types` to a direct
 * dependency so the import cannot break under hoisting changes.
 */
export type {
  AgentApi,
  AgentDescription,
  AgentDesignIssue,
  AgentLoadDesignResult,
  AgentTarget,
  JSONTemplate,
} from '@unlayer/types';
