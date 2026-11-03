import {
  type SolverLink,
  type SolverNode,
  adjacency,
  dependencies,
  dependents,
  round,
  tarjanScc,
} from './graph';
import { type EdgeState, type RailState, solvePower } from './power';

export type DomainMode = 'distributed_infra' | 'hardware_pcb';

export type NodeDiagnosis = {
  nodeId: string;
  effectiveLatencyMs: number;
  failProbability: number;
  rootCauseScore: number;
  derivedStatus: SolverNode['status'];
  rail: RailState | null;
};

export type Diagnosis = {
  sccs: string[][];
  cyclic: string[][];
  nodes: Map<string, NodeDiagnosis>;
  criticalPath: string[];
  criticalPathLatencyMs: number;
  faultNodeIds: string[];
  affectedNodeIds: string[];
  blastRadiusPct: number;
  edges: Map<string, EdgeState>;
};

// Patches other than isolate/restart only disturb dependents whose cumulative
// coupling to the target stays at or above this strength.
export const PROPAGATION_THRESHOLD = 0.35;

function selfFailure(n: SolverNode): number {
  if (n.status === 'ISOLATED') return 0;
  if (n.status === 'FAULT') return Math.max(0.5, n.errorRatePct / 100);
  return Math.min(1, Math.max(0, n.errorRatePct / 100));
}

export function blastPct(nodes: SolverNode[], affected: Iterable<string>): number {
  const total = nodes.reduce((s, n) => s + n.trafficSharePct, 0);
  if (total <= 0) return 0;
  const set = new Set(affected);
  const hit = nodes.filter((n) => set.has(n.id)).reduce((s, n) => s + n.trafficSharePct, 0);
  return round((hit / total) * 100, 2);
}

export function diagnose(mode: DomainMode, nodes: SolverNode[], links: SolverLink[], focusNodeId?: string): Diagnosis {
  const adj = adjacency(nodes, links);
  const sccs = tarjanScc(nodes, adj);
  const order = sccs.flat();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // L_eff(u) = L_base(u) + Σ w_uv · L_eff(v);  P(u) = 1 − (1 − p_u) Π (1 − w_uv · P(v))
  // Solved component by component in dependency order; inside a cyclic SCC
  // the equations are iterated to their fixed point.
  const lat = new Map<string, number>();
  const pf = new Map<string, number>();
  for (const comp of sccs) {
    for (const id of comp) {
      lat.set(id, byId.get(id)!.baseLatencyMs);
      pf.set(id, selfFailure(byId.get(id)!));
    }
    const iterations = comp.length > 1 ? 200 : 1;
    for (let k = 0; k < iterations; k++) {
      let delta = 0;
      for (const id of comp) {
        const n = byId.get(id)!;
        let l = n.status === 'ISOLATED' ? 0 : n.baseLatencyMs;
        let survive = 1 - selfFailure(n);
        for (const link of adj.out.get(id) ?? []) {
          l += link.couplingWeight * (lat.get(link.targetNodeId) ?? 0);
          survive *= 1 - link.couplingWeight * (pf.get(link.targetNodeId) ?? 0);
        }
        const p = 1 - survive;
        delta = Math.max(delta, Math.abs(l - lat.get(id)!), Math.abs(p - pf.get(id)!));
        lat.set(id, l);
        pf.set(id, p);
      }
      if (delta < 1e-9) break;
    }
  }

  // Critical path: from the entry with the largest L_eff, follow the
  // dependency whose weighted contribution is largest.
  const entry = [...nodes].filter((n) => (adj.inc.get(n.id) ?? []).length === 0).sort((a, b) => lat.get(b.id)! - lat.get(a.id)!)[0];
  const criticalPath: string[] = [];
  if (entry) {
    const seen = new Set<string>();
    let cur: string | undefined = entry.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      criticalPath.push(cur);
      const next: SolverLink | undefined = [...(adj.out.get(cur) ?? [])]
        .filter((l) => !seen.has(l.targetNodeId))
        .sort((a, b) => b.couplingWeight * lat.get(b.targetNodeId)! - a.couplingWeight * lat.get(a.targetNodeId)!)[0];
      cur = next?.targetNodeId;
    }
  }

  const power = mode === 'hardware_pcb' ? solvePower(nodes, adj, order) : null;

  // Faults: explicit FAULT, error rate ≥ 25%, or a rail off nominal by > 10%.
  const faultNodeIds = nodes
    .filter((n) => {
      if (n.status === 'ISOLATED') return false;
      if (n.status === 'FAULT' || n.errorRatePct >= 25) return true;
      const dev = power?.rails.get(n.id)?.deviationPct;
      return dev !== null && dev !== undefined && Math.abs(dev) > 10;
    })
    .map((n) => n.id);

  // Root-cause score: among faulty nodes, prefer those whose own dependencies
  // are healthy (the deepest faulty node explains the rest).
  const rootScore = new Map<string, number>();
  for (const id of faultNodeIds) {
    const below = [...dependencies(adj, id)].filter((d) => d !== id && faultNodeIds.includes(d));
    const dev = Math.abs(power?.rails.get(id)?.deviationPct ?? 0) / 100;
    rootScore.set(id, round(Math.max(selfFailure(byId.get(id)!), Math.min(1, dev)) / (1 + below.length), 4));
  }

  const seeds = focusNodeId ? [focusNodeId] : faultNodeIds;
  const affected = new Set<string>();
  for (const s of seeds) for (const id of dependents(adj, s).keys()) affected.add(id);

  const diag = new Map<string, NodeDiagnosis>();
  for (const n of nodes) {
    const rail = power?.rails.get(n.id) ?? null;
    let status: SolverNode['status'] = n.status === 'ISOLATED' ? 'ISOLATED' : 'HEALTHY';
    if (status !== 'ISOLATED') {
      if (faultNodeIds.includes(n.id)) status = 'FAULT';
      else if (affected.has(n.id) || (pf.get(n.id) ?? 0) >= 0.1) status = 'DEGRADED';
    }
    diag.set(n.id, {
      nodeId: n.id,
      effectiveLatencyMs: round(lat.get(n.id) ?? 0, 1),
      failProbability: round(pf.get(n.id) ?? 0, 4),
      rootCauseScore: rootScore.get(n.id) ?? 0,
      derivedStatus: status,
      rail,
    });
  }
  return {
    sccs,
    cyclic: sccs.filter((c) => c.length > 1),
    nodes: diag,
    criticalPath,
    criticalPathLatencyMs: entry ? round(lat.get(entry.id)!, 1) : 0,
    faultNodeIds,
    affectedNodeIds: [...affected],
    blastRadiusPct: blastPct(nodes, affected),
    edges: power?.edges ?? new Map(),
  };
}
