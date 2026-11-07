// Invariants the solver must keep on any topology, checked on seeded random
// graphs rather than only on the two demo benches.
import { describe, expect, it } from 'vitest';

import { blastPct, diagnose } from './diagnose';
import { type SolverLink, type SolverNode, adjacency, dependencies, dependents, round, tarjanScc } from './graph';

// Small deterministic PRNG (mulberry32) so every run checks the same graphs.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function node(id: string, over: Partial<SolverNode> = {}): SolverNode {
  return {
    id,
    key: id,
    label: id,
    tier: 'TIER_2',
    baseLatencyMs: 10,
    errorRatePct: 0,
    nominalVoltageV: null,
    measuredVoltageV: null,
    trafficSharePct: 10,
    status: 'HEALTHY',
    config: {},
    ...over,
  };
}

function link(i: number, from: string, to: string, coupling = 1): SolverLink {
  return { id: `l${i}`, sourceNodeId: from, targetNodeId: to, couplingWeight: coupling, resistanceOhms: 0, status: 'ACTIVE' };
}

// Random DAG: edges only go from a higher index to a lower one (u depends on v, v < u).
function randomDag(seed: number, n = 14, p = 0.25): { nodes: SolverNode[]; links: SolverLink[] } {
  const r = rng(seed);
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`, { trafficSharePct: 1 + Math.floor(r() * 20), baseLatencyMs: 1 + Math.floor(r() * 50) }));
  const links: SolverLink[] = [];
  for (let u = 1; u < n; u++) for (let v = 0; v < u; v++) if (r() < p) links.push(link(links.length, `n${u}`, `n${v}`, round(0.2 + r() * 0.8, 2)));
  return { nodes, links };
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];

describe('Tarjan on random graphs', () => {
  it('returns every node exactly once', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      const flat = tarjanScc(nodes, adjacency(nodes, links)).flat();
      expect(flat.sort()).toEqual(nodes.map((n) => n.id).sort());
    }
  });

  it('finds only singleton components in an acyclic graph, dependencies first', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      const sccs = tarjanScc(nodes, adjacency(nodes, links));
      expect(sccs.every((c) => c.length === 1)).toBe(true);
      const pos = new Map(sccs.flat().map((id, i) => [id, i]));
      for (const l of links) expect(pos.get(l.targetNodeId)!).toBeLessThan(pos.get(l.sourceNodeId)!);
    }
  });

  it('collapses a ring into one component and a self-contained pair into another', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
    const links = [link(0, 'a', 'b'), link(1, 'b', 'c'), link(2, 'c', 'a'), link(3, 'd', 'e'), link(4, 'e', 'd')];
    const sccs = tarjanScc(nodes, adjacency(nodes, links)).map((c) => c.sort().join(''));
    expect(sccs.sort()).toEqual(['abc', 'de']);
  });

  it('ignores cut links', () => {
    const nodes = ['a', 'b'].map((id) => node(id));
    const links: SolverLink[] = [link(0, 'a', 'b'), { ...link(1, 'b', 'a'), status: 'CUT' }];
    expect(tarjanScc(nodes, adjacency(nodes, links)).every((c) => c.length === 1)).toBe(true);
  });
});

describe('reachability on random graphs', () => {
  it('a dependent of v always has v among its dependencies (the two searches agree)', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      const adj = adjacency(nodes, links);
      for (const v of nodes) {
        for (const u of dependents(adj, v.id).keys()) expect(dependencies(adj, u).has(v.id)).toBe(true);
      }
    }
  });

  it('keeps coupling strengths in (0, 1] and never exceeds the unthresholded set', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      const adj = adjacency(nodes, links);
      for (const v of nodes) {
        const all = dependents(adj, v.id);
        const strong = dependents(adj, v.id, 0.35);
        for (const [id, s] of strong) {
          expect(all.has(id)).toBe(true);
          expect(s).toBeGreaterThan(0);
          expect(s).toBeLessThanOrEqual(1);
          if (id !== v.id) expect(s).toBeGreaterThanOrEqual(0.35);
        }
      }
    }
  });

  it('uses the strongest path, not the first one found', () => {
    // a → b (0.5) → c (0.5) gives 0.25; a → c directly gives 0.9.
    const nodes = ['a', 'b', 'c'].map((id) => node(id));
    const links = [link(0, 'a', 'b', 0.5), link(1, 'b', 'c', 0.5), link(2, 'a', 'c', 0.9)];
    expect(dependents(adjacency(nodes, links), 'c').get('a')).toBeCloseTo(0.9);
  });
});

describe('blast radius', () => {
  it('is the traffic share of the affected nodes, as a percentage', () => {
    const nodes = [node('a', { trafficSharePct: 30 }), node('b', { trafficSharePct: 10 }), node('c', { trafficSharePct: 60 })];
    expect(blastPct(nodes, ['a', 'b'])).toBe(40);
    expect(blastPct(nodes, [])).toBe(0);
    expect(blastPct(nodes, ['a', 'b', 'c'])).toBe(100);
  });

  it('normalises when shares do not add up to 100, and is 0 with no traffic', () => {
    const nodes = [node('a', { trafficSharePct: 1 }), node('b', { trafficSharePct: 3 })];
    expect(blastPct(nodes, ['b'])).toBe(75);
    expect(blastPct([node('z', { trafficSharePct: 0 })], ['z'])).toBe(0);
  });

  it('is 0% on a healthy graph and stays within [0, 100] with a fault anywhere', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      expect(diagnose('distributed_infra', nodes, links).blastRadiusPct).toBe(0);
      const at = Math.floor(rng(seed * 7)() * nodes.length);
      const faulty = nodes.map((n, i) => (i === at ? { ...n, status: 'FAULT' as const, errorRatePct: 60 } : n));
      const pct = diagnose('distributed_infra', faulty, links).blastRadiusPct;
      expect(pct).toBeGreaterThan(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  it('grows (never shrinks) when a second fault is added', () => {
    for (const seed of SEEDS) {
      const { nodes, links } = randomDag(seed);
      const one = nodes.map((n, i) => (i === 0 ? { ...n, status: 'FAULT' as const, errorRatePct: 60 } : n));
      const two = one.map((n, i) => (i === 5 ? { ...n, status: 'FAULT' as const, errorRatePct: 60 } : n));
      expect(diagnose('distributed_infra', two, links).blastRadiusPct).toBeGreaterThanOrEqual(diagnose('distributed_infra', one, links).blastRadiusPct);
    }
  });

  it('stops at a cut link', () => {
    const nodes = [node('db', { status: 'FAULT', errorRatePct: 80, trafficSharePct: 10 }), node('api', { trafficSharePct: 90 })];
    const live = [link(0, 'api', 'db')];
    const cut: SolverLink[] = [{ ...live[0]!, status: 'CUT' }];
    expect(diagnose('distributed_infra', nodes, live).blastRadiusPct).toBe(100);
    expect(diagnose('distributed_infra', nodes, cut).blastRadiusPct).toBe(10);
  });
});

describe('effective latency', () => {
  it('equals base latency on a node with no dependencies, and adds weighted dependency latency otherwise', () => {
    const nodes = [node('a', { baseLatencyMs: 5 }), node('b', { baseLatencyMs: 20 })];
    const d = diagnose('distributed_infra', nodes, [link(0, 'a', 'b', 0.5)]);
    const byId = d.nodes;
    expect(byId.get('b')!.effectiveLatencyMs).toBe(20);
    expect(byId.get('a')!.effectiveLatencyMs).toBe(15);
  });
});
