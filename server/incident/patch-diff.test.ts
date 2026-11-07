import { describe, expect, it } from 'vitest';

import { keyDeltas, lineDiff, unifiedPatchDiff } from './patch-diff';

const agent = JSON.stringify({ target: 'payments-db', change: { poolMax: 120, timeoutMs: 800 } }, null, 2);
const operator = JSON.stringify({ target: 'payments-db', change: { poolMax: 80, timeoutMs: 1500 } }, null, 2);

describe('patch line diff', () => {
  it('keeps every line when nothing changed', () => {
    const lines = lineDiff(agent, agent);
    expect(lines.every((l) => l.tag === ' ')).toBe(true);
    expect(lines.map((l) => l.text).join('\n')).toBe(agent);
  });

  it('marks only the two edited values', () => {
    const lines = lineDiff(agent, operator);
    expect(lines.filter((l) => l.tag === '-').map((l) => l.text.trim())).toEqual(['"poolMax": 120,', '"timeoutMs": 800']);
    expect(lines.filter((l) => l.tag === '+').map((l) => l.text.trim())).toEqual(['"poolMax": 80,', '"timeoutMs": 1500']);
  });

  it('replays to both sides: context + removals is the before, context + additions is the after', () => {
    const lines = lineDiff(agent, operator);
    expect(lines.filter((l) => l.tag !== '+').map((l) => l.text).join('\n')).toBe(agent);
    expect(lines.filter((l) => l.tag !== '-').map((l) => l.text).join('\n')).toBe(operator);
  });

  it('handles pure insertions and pure deletions', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').map((l) => l.tag).join('')).toBe(' + ');
    expect(lineDiff('a\nb\nc', 'a\nc').map((l) => l.tag).join('')).toBe(' - ');
  });

  it('writes a unified diff header naming the agent draft and the operator final', () => {
    const diff = unifiedPatchDiff(agent, operator, 'pool').split('\n');
    expect(diff[0]).toBe('--- agent_proposed/pool.json');
    expect(diff[1]).toBe('+++ operator_final/pool.json');
    const lineCount = agent.split('\n').length;
    expect(diff[2]).toBe(`@@ -1,${lineCount} +1,${lineCount} @@`);
  });
});

describe('key-path deltas', () => {
  it('reports each changed leaf by its dotted path', () => {
    expect(keyDeltas(JSON.parse(agent), JSON.parse(operator))).toEqual([
      { path: 'change.poolMax', before: 120, after: 80 },
      { path: 'change.timeoutMs', before: 800, after: 1500 },
    ]);
  });

  it('reports added and removed keys with null on the missing side', () => {
    expect(keyDeltas({ a: 1 }, { a: 1, b: { c: true } })).toEqual([{ path: 'b.c', before: null, after: true }]);
    expect(keyDeltas({ a: 1, gone: 'x' }, { a: 1 })).toEqual([{ path: 'gone', before: 'x', after: null }]);
  });

  it('treats arrays as values, not as nested keys', () => {
    expect(keyDeltas({ hosts: ['a', 'b'] }, { hosts: ['a', 'b'] })).toEqual([]);
    expect(keyDeltas({ hosts: ['a'] }, { hosts: ['a', 'b'] })).toEqual([{ path: 'hosts', before: ['a'], after: ['a', 'b'] }]);
  });

  it('is empty for identical objects regardless of key order', () => {
    expect(keyDeltas({ x: 1, y: { z: 2 } }, { y: { z: 2 }, x: 1 })).toEqual([]);
  });
});
