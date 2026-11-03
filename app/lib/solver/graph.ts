// Dependency graph primitives. An edge u → v means "u depends on v": a caller
// depends on its callee, a load depends on its supply rail. A fault at v
// therefore propagates to every node that can reach v.

export type Tier = 'CRITICAL_TIER_1' | 'TIER_2' | 'EDGE';
export type NodeStatus = 'HEALTHY' | 'DEGRADED' | 'FAULT' | 'ISOLATED';

export type SolverNode = {
  id: string;
  key: string;
  label: string;
  tier: Tier;
  baseLatencyMs: number;
  errorRatePct: number;
  nominalVoltageV: number | null;
  measuredVoltageV: number | null;
  trafficSharePct: number;
  status: NodeStatus;
  config: Record<string, unknown>;
};

export type SolverLink = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  couplingWeight: number;
  resistanceOhms: number;
  status: 'ACTIVE' | 'CUT';
};

export type Adjacency = {
  out: Map<string, SolverLink[]>;
  inc: Map<string, SolverLink[]>;
};

export function adjacency(nodes: SolverNode[], links: SolverLink[]): Adjacency {
  const out = new Map<string, SolverLink[]>();
  const inc = new Map<string, SolverLink[]>();
  for (const n of nodes) {
    out.set(n.id, []);
    inc.set(n.id, []);
  }
  for (const l of links) {
    if (l.status !== 'ACTIVE') continue;
    out.get(l.sourceNodeId)?.push(l);
    inc.get(l.targetNodeId)?.push(l);
  }
  return { out, inc };
}

// Tarjan's strongly connected components, iterative to avoid deep recursion.
export function tarjanScc(nodes: SolverNode[], adj: Adjacency): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  for (const start of nodes) {
    if (idx.has(start.id)) continue;
    const work: { v: string; i: number }[] = [{ v: start.id, i: 0 }];
    idx.set(start.id, index);
    low.set(start.id, index);
    index++;
    stack.push(start.id);
    onStack.add(start.id);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const edges = adj.out.get(frame.v) ?? [];
      if (frame.i < edges.length) {
        const w = edges[frame.i]!.targetNodeId;
        frame.i++;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
        if (low.get(frame.v) === idx.get(frame.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          result.push(comp);
        }
      }
    }
  }
  // Tarjan emits components in reverse topological order of the condensation
  // (dependencies before dependents) — exactly the order DP needs.
  return result;
}

// Nodes that depend on `from` directly or transitively (the blast radius),
// optionally only through edges whose cumulative coupling stays ≥ threshold.
export function dependents(adj: Adjacency, from: string, couplingThreshold = 0): Map<string, number> {
  const best = new Map<string, number>([[from, 1]]);
  const queue: string[] = [from];
  while (queue.length) {
    const v = queue.shift()!;
    const strength = best.get(v)!;
    for (const link of adj.inc.get(v) ?? []) {
      const s = strength * link.couplingWeight;
      if (couplingThreshold > 0 && s < couplingThreshold) continue;
      if (s > (best.get(link.sourceNodeId) ?? -1)) {
        best.set(link.sourceNodeId, s);
        queue.push(link.sourceNodeId);
      }
    }
  }
  return best;
}

// Nodes `from` depends on (candidate upstream root causes).
export function dependencies(adj: Adjacency, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length) {
    const v = queue.shift()!;
    for (const link of adj.out.get(v) ?? []) {
      if (!seen.has(link.targetNodeId)) {
        seen.add(link.targetNodeId);
        queue.push(link.targetNodeId);
      }
    }
  }
  return seen;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
