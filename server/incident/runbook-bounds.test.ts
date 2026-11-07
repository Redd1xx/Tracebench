import { describe, expect, it } from 'vitest';

import type { Patch } from '../../app/lib/solver/patch';
import { sidesFromUnifiedDiff, unifiedPatchDiff } from './patch-diff';
import { applyRunbookBounds, type LearnedEdit } from './runbook-bounds';

const pool = (poolMax: number, extra: Record<string, number> = {}): Patch => ({
  kind: 'config',
  target: 'payments-db',
  set: { config: { poolMax, ...extra } },
});

const raised: LearnedEdit = { ruleId: 'r1', agentPatch: pool(60), operatorPatch: pool(80) };

describe('runbook bounds on agent patches', () => {
  it('lifts a value the operator previously raised', () => {
    const { patch, adjustments } = applyRunbookBounds(pool(60), [raised]);
    expect(patch.set?.config?.poolMax).toBe(80);
    expect(adjustments).toEqual([{ ruleId: 'r1', path: 'set.config.poolMax', proposed: 60, applied: 80 }]);
  });

  it('also lifts a value below the original agent proposal', () => {
    expect(applyRunbookBounds(pool(50), [raised]).patch.set?.config?.poolMax).toBe(80);
  });

  it('leaves values already at or beyond the operator value', () => {
    for (const v of [80, 120]) {
      const out = applyRunbookBounds(pool(v), [raised]);
      expect(out.patch.set?.config?.poolMax).toBe(v);
      expect(out.adjustments).toEqual([]);
    }
  });

  it('honours a lowered value as an upper bound', () => {
    const lowered: LearnedEdit = { ruleId: 'r2', agentPatch: pool(80, { timeoutMs: 3000 }), operatorPatch: pool(80, { timeoutMs: 1500 }) };
    const { patch, adjustments } = applyRunbookBounds(pool(80, { timeoutMs: 2500 }), [lowered]);
    expect(patch.set?.config?.timeoutMs).toBe(1500);
    expect(adjustments.map((a) => a.path)).toEqual(['set.config.timeoutMs']);
  });

  it('ignores other targets, other kinds, and keys the new patch does not set', () => {
    expect(applyRunbookBounds({ ...pool(60), target: 'ledger-writer' }, [raised]).adjustments).toEqual([]);
    expect(applyRunbookBounds({ ...pool(60), kind: 'restart' }, [raised]).adjustments).toEqual([]);
    const noPool: Patch = { kind: 'config', target: 'payments-db', set: { config: { timeoutMs: 900 } } };
    expect(applyRunbookBounds(noPool, [raised])).toEqual({ patch: noPool, adjustments: [] });
  });

  it('lets the newest rule win and never mutates the input', () => {
    const older: LearnedEdit = { ruleId: 'old', agentPatch: pool(60), operatorPatch: pool(100) };
    const input = pool(60);
    const { patch, adjustments } = applyRunbookBounds(input, [raised, older]);
    expect(patch.set?.config?.poolMax).toBe(80);
    expect(adjustments.map((a) => a.ruleId)).toEqual(['r1']);
    expect(input.set?.config?.poolMax).toBe(60);
  });
});

describe('sidesFromUnifiedDiff', () => {
  it('replays both patches from a stored rule diff', () => {
    const before = JSON.stringify(pool(60, { timeoutMs: 1500 }), null, 2);
    const after = JSON.stringify(pool(80, { timeoutMs: 1500 }), null, 2);
    expect(sidesFromUnifiedDiff(unifiedPatchDiff(before, after, 'payments-db'))).toEqual({ before, after });
  });
});
