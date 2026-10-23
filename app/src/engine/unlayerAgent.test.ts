/**
 * M6 tests for the typed adapter additions (`getAgentSchema`) and the
 * existing adapter surface, using a stubbed global. Verifies the runtime
 * feature-detection contract: real `schema()` passes through, older
 * builders without it fail with a displayable error instead of
 * `undefined is not a function`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeAgent, getAgentDesign, getAgentSchema } from './unlayerAgent';

type MutableGlobal = { unlayer?: { agent?: unknown } };

function globalScope(): MutableGlobal {
  return globalThis as unknown as MutableGlobal;
}

const realUnlayer = globalScope().unlayer;

afterEach(() => {
  if (realUnlayer === undefined) delete globalScope().unlayer;
  else globalScope().unlayer = realUnlayer;
});

describe('unlayerAgent', () => {
  it('passes describe and getDesign through to the global agent', async () => {
    const describe = vi.fn(async () => ({ editors: [{ index: 0, containerId: 'editor' }] }));
    const getDesign = vi.fn(async () => ({ counters: {}, body: { rows: [] } }));
    globalScope().unlayer = { agent: { describe, getDesign } };

    const details = await describeAgent();
    expect(details.editors).toHaveLength(1);
    expect(describe).toHaveBeenCalledTimes(1);
    const design = await getAgentDesign();
    expect(design).toEqual({ counters: {}, body: { rows: [] } });
    expect(getDesign).toHaveBeenCalledTimes(1);
  });

  it('throws a displayable error when the agent API is absent', () => {
    globalScope().unlayer = {};
    expect(() => describeAgent()).toThrow('Agent API unavailable');
    expect(() => getAgentSchema()).toThrow('Agent API unavailable');
  });

  it('returns the design JSON schema when the builder supports it', async () => {
    const schema = { type: 'object', properties: { body: { type: 'object' } } };
    globalScope().unlayer = { agent: { schema: async () => schema } };
    await expect(getAgentSchema()).resolves.toEqual(schema);
  });

  it('reports unsupported schema APIs instead of crashing', () => {
    globalScope().unlayer = { agent: { describe: async () => ({ editors: [] }) } };
    expect(() => getAgentSchema()).toThrow('Agent schema API is not supported by this builder.');
  });
});
