import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { z } from 'zod';

import { diagnose } from '../app/lib/solver/diagnose';
import { adjacency, dependencies, dependents } from '../app/lib/solver/graph';
import { loadGraph, loadTopology, toSolverLink, toSolverNode } from '../server/incident/bench.js';

export default defineAction({
  description:
    "Run the solver on a bench: Tarjan SCC, reachability, topological latency L_eff(u) = L_base(u) + Σ w·L_eff(v), cascading failure P(u) = 1 − (1 − p_u)·Π(1 − w·P(v)), and for PCB boards the nodal IR-drop / I²R solve. With faultNodeId, returns that node's exact downstream blast subgraph (dependents with coupling strength), upstream dependency set, and blast_radius_pct; otherwise uses every detected fault.",
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    faultNodeId: z.string().optional().describe('Node to treat as the fault origin; omit to use all detected faults'),
  }),
  outputSchema: z.object({
    graphId: z.string(),
    origin: z.array(z.string()),
    blastRadiusPct: z.number(),
    affected: z.array(z.object({ nodeId: z.string(), key: z.string(), couplingStrength: z.number() })),
    upstream: z.array(z.string()),
    cyclicSccs: z.array(z.array(z.string())),
    criticalPath: z.array(z.string()),
    criticalPathLatencyMs: z.number(),
    rootCauses: z.array(z.object({ key: z.string(), score: z.number() })),
    rails: z.array(z.object({ key: z.string(), expectedV: z.number(), measuredV: z.number().nullable(), currentA: z.number() })),
  }),
  readOnly: true,
  run: async ({ graphId, faultNodeId }) => {
    await assertAccess('service-graph', graphId, 'viewer');
    const graph = await loadGraph(graphId);
    const { nodes: rows, links: linkRows } = await loadTopology(graph);
    const nodes = rows.map(toSolverNode);
    const links = linkRows.map(toSolverLink);
    if (faultNodeId && !nodes.some((n) => n.id === faultNodeId || n.key === faultNodeId)) {
      fail('Node not found on this graph.', { errorCode: 'node_not_found', statusCode: 404 });
    }
    const focus = faultNodeId ? nodes.find((n) => n.id === faultNodeId || n.key === faultNodeId)!.id : undefined;
    const d = diagnose(graph.domainMode, nodes, links, focus);
    const adj = adjacency(nodes, links);
    const origins = focus ? [focus] : d.faultNodeIds;
    const strength = new Map<string, number>();
    for (const o of origins) for (const [id, s] of dependents(adj, o)) strength.set(id, Math.max(strength.get(id) ?? 0, s));
    const up = new Set<string>();
    for (const o of origins) for (const id of dependencies(adj, o)) up.add(id);
    const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
    return {
      graphId: graph.id,
      origin: origins.map((o) => keyOf.get(o)!),
      blastRadiusPct: d.blastRadiusPct,
      affected: [...strength].map(([nodeId, s]) => ({ nodeId, key: keyOf.get(nodeId)!, couplingStrength: Math.round(s * 1000) / 1000 })).sort((a, b) => b.couplingStrength - a.couplingStrength),
      upstream: [...up].filter((id) => !origins.includes(id)).map((id) => keyOf.get(id)!),
      cyclicSccs: d.cyclic.map((c) => c.map((id) => keyOf.get(id)!)),
      criticalPath: d.criticalPath.map((id) => keyOf.get(id)!),
      criticalPathLatencyMs: d.criticalPathLatencyMs,
      rootCauses: d.faultNodeIds.map((id) => ({ key: keyOf.get(id)!, score: d.nodes.get(id)!.rootCauseScore })).sort((a, b) => b.score - a.score),
      rails: graph.domainMode === 'hardware_pcb'
        ? nodes.map((n) => {
            const r = d.nodes.get(n.id)!.rail!;
            return { key: n.key, expectedV: r.expectedVoltageV, measuredV: n.measuredVoltageV, currentA: r.outputCurrentA };
          })
        : [],
    };
  },
});
