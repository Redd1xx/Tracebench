// Turns metabolized operator edits into deterministic bounds on new agent patches.
//
// When an operator moved a numeric value (e.g. poolMax 60 → 80) before
// countersigning, that edit says "for this node, go at least this far in that
// direction". A later agent patch on the same node and patch kind that sets the
// same key, but stops short of the operator's value, is lifted to it.
// Values already at or beyond the operator's value are left alone.

import type { Patch } from '../../app/lib/solver/patch';
import { keyDeltas } from './patch-diff';

export type LearnedEdit = { ruleId: string; agentPatch: Patch; operatorPatch: Patch };
export type RunbookAdjustment = { ruleId: string; path: string; proposed: number; applied: number };

const LEARNABLE = /^set\.(baseLatencyMs|errorRatePct|trafficSharePct|config\.[^.]+)$/;

function read(patch: Patch, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), patch);
}

function write(patch: Patch, path: string, value: number): void {
  const keys = path.split('.');
  let obj = patch as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
  obj[keys[keys.length - 1]!] = value;
}

/** Newest edits first; the first rule that bounds a path wins. */
export function applyRunbookBounds(patch: Patch, edits: LearnedEdit[]): { patch: Patch; adjustments: RunbookAdjustment[] } {
  const next = structuredClone(patch);
  const adjustments: RunbookAdjustment[] = [];
  const settled = new Set<string>();
  for (const edit of edits) {
    if (edit.operatorPatch.target !== patch.target || edit.operatorPatch.kind !== patch.kind) continue;
    for (const d of keyDeltas(edit.agentPatch, edit.operatorPatch)) {
      if (settled.has(d.path) || !LEARNABLE.test(d.path)) continue;
      if (typeof d.before !== 'number' || typeof d.after !== 'number') continue;
      const proposed = read(next, d.path);
      if (typeof proposed !== 'number') continue;
      settled.add(d.path);
      const up = d.after > d.before;
      if (up ? proposed < d.after : proposed > d.after) {
        write(next, d.path, d.after);
        adjustments.push({ ruleId: edit.ruleId, path: d.path, proposed, applied: d.after });
      }
    }
  }
  return { patch: next, adjustments };
}
