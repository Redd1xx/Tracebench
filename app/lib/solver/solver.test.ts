import { describe, expect, it } from 'vitest';

import { SEED_TOPOLOGIES } from '../../../server/seed/topologies';
import { diagnose } from './diagnose';
import { type SolverLink, type SolverNode, adjacency, dependencies, dependents, tarjanScc } from './graph';
import { applyPatch, canonicalPatch, parsePatch, patchImpact } from './patch';

function seed(name: string): { nodes: SolverNode[]; links: SolverLink[]; mode: 'distributed_infra' | 'hardware_pcb' } {
  const t = SEED_TOPOLOGIES.find((x) => x.name === name)!;
  const nodes: SolverNode[] = t.nodes.map((n) => ({
    id: n.key,
    key: n.key,
    label: n.label,
    tier: n.tier,
    baseLatencyMs: n.baseLatencyMs,
    errorRatePct: n.errorRatePct,
    nominalVoltageV: n.nominalVoltageV,
    measuredVoltageV: n.measuredVoltageV,
    trafficSharePct: n.trafficSharePct,
    status: n.status,
    config: n.config,
  }));
  const links: SolverLink[] = t.links.map((l, i) => ({ id: `l${i}`, sourceNodeId: l.from, targetNodeId: l.to, couplingWeight: l.coupling, resistanceOhms: l.ohms, status: 'ACTIVE' }));
  return { nodes, links, mode: t.domainMode };
}

const mesh = seed('Global Payment Checkout Mesh');
const board = seed('Embedded Power Distribution Board');

describe('Tarjan SCC and reachability', () => {
  it('finds exactly the ledger ⇄ kafka consumer loop', () => {
    const cyclic = tarjanScc(mesh.nodes, adjacency(mesh.nodes, mesh.links)).filter((c) => c.length > 1);
    expect(cyclic.map((c) => [...c].sort())).toEqual([['kafka-events', 'ledger-writer']]);
  });

  it('emits components dependencies-first', () => {
    const order = tarjanScc(mesh.nodes, adjacency(mesh.nodes, mesh.links)).flat();
    expect(order.indexOf('payments-db')).toBeLessThan(order.indexOf('payment-orchestrator'));
    expect(order.indexOf('api-gateway')).toBeLessThan(order.indexOf('edge-cdn'));
  });

  it('separates dependents (blast) from dependencies (upstream)', () => {
    const adj = adjacency(mesh.nodes, mesh.links);
    const blast = [...dependents(adj, 'payments-db').keys()];
    expect(blast).toEqual(expect.arrayContaining(['payment-orchestrator', 'checkout-svc', 'edge-cdn', 'kafka-events']));
    expect(blast).not.toContain('cart-svc');
    expect([...dependencies(adj, 'checkout-svc')]).toContain('payments-db');
  });

  it('respects coupling thresholds', () => {
    const adj = adjacency(mesh.nodes, mesh.links);
    const strong = [...dependents(adj, 'kafka-events', 0.35).keys()].sort();
    expect(strong).toEqual(['kafka-events', 'ledger-writer']);
  });
});

describe('payment mesh diagnosis', () => {
  const d = diagnose(mesh.mode, mesh.nodes, mesh.links);

  it('isolates the exhausted payments-db pool as the only fault', () => {
    expect(d.faultNodeIds).toEqual(['payments-db']);
  });

  it('computes an 83% blast radius by traffic share', () => {
    expect(d.blastRadiusPct).toBe(83);
  });

  it('propagates latency through the critical path', () => {
    expect(d.criticalPath).toEqual(['edge-cdn', 'api-gateway', 'checkout-svc', 'payment-orchestrator', 'payments-db']);
    expect(d.criticalPathLatencyMs).toBeCloseTo(1009.6, 1);
  });

  it('cascades failure probability: P(u) = 1 − (1 − p_u)·Π(1 − w·P(v))', () => {
    const orch = d.nodes.get('payment-orchestrator')!;
    expect(orch.failProbability).toBeGreaterThan(0.38);
    expect(d.nodes.get('cart-svc')!.failProbability).toBeLessThan(0.01);
  });
});

describe('power board nodal solve', () => {
  const d = diagnose(board.mode, board.nodes, board.links);

  it('folds the shorted 3V3 buck back to ~0.45 V at its 3 A limit', () => {
    const rail = d.nodes.get('buck-3v3')!.rail!;
    expect(rail.expectedVoltageV).toBeCloseTo(0.448, 2);
    expect(rail.outputCurrentA).toBeCloseTo(3.1, 1);
  });

  it('drags the rails it feeds down with it and leaves the others nominal', () => {
    expect([...d.faultNodeIds].sort()).toEqual(['buck-3v3', 'ldo-1v8', 'sensor-afe']);
    expect(d.nodes.get('ldo-1v2')!.rail!.expectedVoltageV).toBeCloseTo(1.2, 3);
    expect(d.nodes.get('buck-3v3')!.rootCauseScore).toBeGreaterThan(d.nodes.get('ldo-1v8')!.rootCauseScore);
  });

  it('computes I·R drop and I²R heat on each trace', () => {
    const radioLink = board.links.find((l) => l.sourceNodeId === 'radio-pa')!;
    const edge = d.edges.get(radioLink.id)!;
    expect(edge.currentA).toBeCloseTo(0.8, 3);
    expect(edge.dropV).toBeCloseTo(0.8 * 0.05, 4);
    expect(edge.dissipationW).toBeCloseTo(0.8 * 0.8 * 0.05, 4);
  });
});

describe('patches', () => {
  it('scopes a Kafka consumer tune to 9% and a DB pool change to 74%', () => {
    const kafka = parsePatch('{"kind":"config","target":"kafka-events","set":{"config":{"consumerLag":0}}}');
    const db = parsePatch('{"kind":"config","target":"payments-db","set":{"errorRatePct":0.5}}');
    if (!kafka.ok || !db.ok) throw new Error('fixture patches must parse');
    expect(patchImpact(kafka.patch, mesh.nodes, mesh.links)?.blastRadiusPct).toBe(9);
    expect(patchImpact(db.patch, mesh.nodes, mesh.links)?.blastRadiusPct).toBe(74);
  });

  it('hashes canonically: key order is ignored, nested values are not', () => {
    const a = canonicalPatch('{"kind":"config","target":"payments-db","set":{"config":{"poolMax":80,"timeoutMs":1500}}}');
    const b = canonicalPatch('{"set":{"config":{"timeoutMs":1500,"poolMax":80}},"target":"payments-db","kind":"config"}');
    const c = canonicalPatch('{"kind":"config","target":"payments-db","set":{"config":{"poolMax":120,"timeoutMs":1500}}}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('rejects malformed patches with a reason', () => {
    expect(parsePatch('{oops').ok).toBe(false);
    const bad = parsePatch('{"kind":"delete-everything","target":"x"}');
    expect(bad.ok).toBe(false);
  });

  it('clears the incident when the pool fix is applied', () => {
    const fix = parsePatch('{"kind":"config","target":"payments-db","set":{"errorRatePct":0.5,"baseLatencyMs":40}}');
    if (!fix.ok) throw new Error('fixture patch must parse');
    const after = applyPatch(fix.patch, mesh.nodes, mesh.links, mesh.mode);
    const d = diagnose(mesh.mode, after.nodes, after.links);
    expect(d.faultNodeIds).toEqual([]);
    expect(d.blastRadiusPct).toBe(0);
  });

  it('clears the incident when the pool gets headroom, and not when it stays exhausted', () => {
    const relieved = parsePatch('{"kind":"config","target":"payments-db","set":{"config":{"poolMax":80,"timeoutMs":1500}}}');
    const starved = parsePatch('{"kind":"config","target":"payments-db","set":{"config":{"poolMax":40,"timeoutMs":1500}}}');
    if (!relieved.ok || !starved.ok) throw new Error('fixture patches must parse');
    const fixed = applyPatch(relieved.patch, mesh.nodes, mesh.links, mesh.mode);
    expect(diagnose(mesh.mode, fixed.nodes, fixed.links).blastRadiusPct).toBe(0);
    const still = applyPatch(starved.patch, mesh.nodes, mesh.links, mesh.mode);
    expect(diagnose(mesh.mode, still.nodes, still.links).faultNodeIds.length).toBeGreaterThan(0);
  });

  it('isolating the shorted rail cuts its loads off', () => {
    const iso = parsePatch('{"kind":"isolate","target":"buck-3v3"}');
    if (!iso.ok) throw new Error('fixture patch must parse');
    expect(patchImpact(iso.patch, board.nodes, board.links)?.blastRadiusPct).toBe(31);
    const after = applyPatch(iso.patch, board.nodes, board.links, board.mode);
    expect(after.nodes.find((n) => n.key === 'buck-3v3')?.status).toBe('ISOLATED');
    expect(after.links.filter((l) => l.targetNodeId === 'buck-3v3').every((l) => l.status === 'CUT')).toBe(true);
  });
});
