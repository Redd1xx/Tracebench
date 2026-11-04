// Unified line diff for remediation patches (pretty-printed JSON), via a
// longest-common-subsequence table, plus a flat key-path delta.

type Line = { tag: ' ' | '-' | '+'; text: string };

export function lineDiff(before: string, after: string): Line[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i]! });
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push({ tag: '-', text: a[i++]! });
    else out.push({ tag: '+', text: b[j++]! });
  }
  while (i < a.length) out.push({ tag: '-', text: a[i++]! });
  while (j < b.length) out.push({ tag: '+', text: b[j++]! });
  return out;
}

export function unifiedPatchDiff(before: string, after: string, name: string): string {
  const lines = lineDiff(before, after);
  const removed = lines.filter((l) => l.tag !== '+').length;
  const added = lines.filter((l) => l.tag !== '-').length;
  return [`--- agent_proposed/${name}.json`, `+++ operator_final/${name}.json`, `@@ -1,${removed} +1,${added} @@`, ...lines.map((l) => `${l.tag}${l.text}`)].join('\n');
}

export type KeyDelta = { path: string; before: unknown; after: unknown };

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
}

export function keyDeltas(before: unknown, after: unknown): KeyDelta[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(before, '', a);
  flatten(after, '', b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths
    .filter((p) => JSON.stringify(a.get(p)) !== JSON.stringify(b.get(p)))
    .map((p) => ({ path: p, before: a.get(p) ?? null, after: b.get(p) ?? null }));
}

/** Inverse of unifiedPatchDiff: the diff carries every line, so both sides replay exactly. */
export function sidesFromUnifiedDiff(diff: string): { before: string; after: string } {
  const body = diff.split('\n').slice(3);
  const side = (skip: string) => body.filter((l) => l[0] !== skip).map((l) => l.slice(1)).join('\n');
  return { before: side('+'), after: side('-') };
}
