import { defineAction } from '@agent-native/core/action';
import { readAppState, readAppStateForCurrentTab } from '@agent-native/core/application-state';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { diagnose } from '../app/lib/solver/diagnose';
import { adjacency, dependencies, dependents } from '../app/lib/solver/graph';
import { getDb, schema } from '../server/db/index.js';
import { loadGraph, loadTopology, toSolverLink, toSolverNode } from '../server/incident/bench.js';

type Navigation = {
  view?: string;
  graphId?: string;
  selectedNodeId?: string;
  activeFrameIndex?: number;
  openGateId?: string;
};

export default defineAction({
  description:
    "Read what the operator is looking at: the active bench, the selected node with its solved state, its upstream dependency path and downstream blast radius, the timeline frame being viewed (live or a historical preview), and the open rollout gate with its blast radius, shield requirement and patch hash.",
  schema: z.object({}),
  outputSchema: z.object({
    navigation: z.record(z.string(), z.unknown()).nullable(),
    selection: z.unknown().nullable(),
    graph: z.record(z.string(), z.unknown()).nullable(),
    selectedNode: z.record(z.string(), z.unknown()).nullable(),
    frame: z.record(z.string(), z.unknown()).nullable(),
    openGate: z.record(z.string(), z.unknown()).nullable(),
  }),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = (await readAppState('navigation')) as Navigation | null;
    const selection = await readAppStateForCurrentTab('bench-selection').catch(() => null);
    const empty = { navigation: (navigation as Record<string, unknown> | null) ?? null, selection: selection ?? null, graph: null, selectedNode: null, frame: null, openGate: null };
    if (!navigation?.graphId) return empty;
    try {
      await assertAccess('service-graph', navigation.graphId, 'viewer');
    } catch {
      return empty;
    }
    const graph = await loadGraph(navigation.graphId);
    const { nodes: rows, links: linkRows } = await loadTopology(graph);
    const nodes = rows.map(toSolverNode);
    const links = linkRows.map(toSolverLink);
    const d = diagnose(graph.domainMode, nodes, links);
    const adj = adjacency(nodes, links);
    const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
    const node = nodes.find((n) => n.id === navigation.selectedNodeId) ?? null;
    let selectedNode: Record<string, unknown> | null = null;
    if (node) {
      const nd = d.nodes.get(node.id)!;
      const blast = dependents(adj, node.id);
      selectedNode = {
        id: node.id,
        key: node.key,
        tier: node.tier,
        status: nd.derivedStatus,
        effectiveLatencyMs: nd.effectiveLatencyMs,
        failProbability: nd.failProbability,
        errorRatePct: node.errorRatePct,
        expectedVoltageV: nd.rail?.expectedVoltageV ?? null,
        measuredVoltageV: node.measuredVoltageV,
        upstreamPath: [...dependencies(adj, node.id)].filter((id) => id !== node.id).map((id) => keyOf.get(id)),
        downstreamBlastRadius: [...blast.keys()].filter((id) => id !== node.id).map((id) => keyOf.get(id)),
        config: node.config,
      };
    }
    const db = getDb();
    const frameSeq = navigation.activeFrameIndex ?? graph.activeFrameSeq;
    const [frame] =
      frameSeq !== null && frameSeq !== undefined
        ? await db
            .select({ seq: schema.incidentFrames.frameSeq, eventType: schema.incidentFrames.eventType, summary: schema.incidentFrames.summary, blast: schema.incidentFrames.blastRadiusPct })
            .from(schema.incidentFrames)
            .where(and(eq(schema.incidentFrames.graphId, graph.id), eq(schema.incidentFrames.ownerEmail, graph.ownerEmail), eq(schema.incidentFrames.frameSeq, frameSeq)))
            .limit(1)
        : [];
    const [gate] = navigation.openGateId
      ? await db
          .select()
          .from(schema.rolloutGates)
          .where(and(eq(schema.rolloutGates.id, navigation.openGateId), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)))
          .limit(1)
      : [];
    return {
      navigation: navigation as Record<string, unknown>,
      selection: selection ?? null,
      graph: {
        id: graph.id,
        name: graph.name,
        domainMode: graph.domainMode,
        agentBlastCapPct: graph.agentBlastCapPct,
        faults: d.faultNodeIds.map((id) => keyOf.get(id)),
        blastRadiusPct: d.blastRadiusPct,
        cyclicSccs: d.cyclic.map((c) => c.map((id) => keyOf.get(id))),
        criticalPath: d.criticalPath.map((id) => keyOf.get(id)),
      },
      selectedNode,
      frame: frame ? { seq: frame.seq, eventType: frame.eventType, summary: frame.summary, blastRadiusPct: frame.blast, isLive: navigation.activeFrameIndex === undefined } : null,
      openGate: gate
        ? {
            id: gate.id,
            status: gate.status,
            target: keyOf.get(gate.targetNodeId),
            computedBlastRadiusPct: gate.computedBlastRadiusPct,
            requiresHumanShield: gate.requiresHumanShield,
            patchDiffHash: gate.patchDiffHash,
            agentProposedPatch: gate.agentProposedPatch,
            operatorFinalPatch: gate.operatorFinalPatch,
          }
        : null,
    };
  },
});
