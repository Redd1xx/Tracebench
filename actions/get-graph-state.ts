import { defineAction } from '@agent-native/core/action';
import { buildDeepLink } from '@agent-native/core/server';
import { assertAccess } from '@agent-native/core/sharing';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { diagnose } from '../app/lib/solver/diagnose';
import { getDb, schema } from '../server/db/index.js';
import { loadGraph, loadTopology, toSolverLink, toSolverNode } from '../server/incident/bench.js';

const frameNodeSchema = z.object({
  id: z.string(),
  baseLatencyMs: z.number(),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(['HEALTHY', 'DEGRADED', 'FAULT', 'ISOLATED']),
  errorRatePct: z.number(),
  effectiveLatencyMs: z.number(),
  failProbability: z.number(),
  expectedVoltageV: z.number().nullable(),
  measuredVoltageV: z.number().nullable(),
  affected: z.boolean(),
});

export default defineAction({
  description:
    'Read a bench in full: nodes with solved effective latency, failure probability, expected vs measured rail voltage and status; links with IR drop and I²R dissipation; recent probe samples; every timeline frame (immutable snapshots); rollout gates with blast radius and patch hash; and the live diagnosis (cyclic SCCs, critical path, faults ranked by root-cause score, blast radius).',
  schema: z.object({ id: z.string().describe('Graph id from list-graphs') }),
  outputSchema: z.object({
    graph: z.object({
      id: z.string(),
      name: z.string(),
      domainMode: z.enum(['distributed_infra', 'hardware_pcb']),
      agentBlastCapPct: z.number(),
      activeFrameSeq: z.number().nullable(),
      updatedAt: z.string(),
    }),
    nodes: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        label: z.string(),
        tier: z.enum(['CRITICAL_TIER_1', 'TIER_2', 'EDGE']),
        x: z.number(),
        y: z.number(),
        baseLatencyMs: z.number(),
        effectiveLatencyMs: z.number(),
        errorRatePct: z.number(),
        failProbability: z.number(),
        nominalVoltageV: z.number().nullable(),
        measuredVoltageV: z.number().nullable(),
        expectedVoltageV: z.number().nullable(),
        currentA: z.number().nullable(),
        trafficSharePct: z.number(),
        status: z.enum(['HEALTHY', 'DEGRADED', 'FAULT', 'ISOLATED']),
        rootCauseScore: z.number(),
        config: z.record(z.string(), z.unknown()),
      }),
    ),
    links: z.array(
      z.object({
        id: z.string(),
        sourceNodeId: z.string(),
        targetNodeId: z.string(),
        couplingWeight: z.number(),
        resistanceOhms: z.number(),
        status: z.enum(['ACTIVE', 'CUT']),
        currentA: z.number().nullable(),
        dropV: z.number().nullable(),
        dissipationW: z.number().nullable(),
      }),
    ),
    probes: z.array(
      z.object({ id: z.string(), nodeId: z.string(), metricName: z.string(), measuredValue: z.number(), unit: z.string(), recordedBy: z.string(), createdAt: z.string() }),
    ),
    frames: z.array(
      z.object({ seq: z.number(), eventType: z.string(), summary: z.string(), blastRadiusPct: z.number(), timestampUs: z.number(), nodes: z.array(frameNodeSchema) }),
    ),
    gates: z.array(
      z.object({
        id: z.string(),
        targetNodeId: z.string(),
        agentProposedPatch: z.string(),
        operatorFinalPatch: z.string().nullable(),
        patchDiffHash: z.string(),
        computedBlastRadiusPct: z.number(),
        affectedNodeIds: z.array(z.string()),
        requiresHumanShield: z.boolean(),
        stagedBy: z.string(),
        status: z.enum(['SHIELDED_PENDING', 'APPROVED_APPLIED', 'REJECTED']),
        approvedBy: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    learnedRules: z.array(z.object({ id: z.string(), nodeKey: z.string(), rule: z.string(), createdAt: z.string() })),
    diagnosis: z.object({
      cyclicSccs: z.array(z.array(z.string())),
      criticalPath: z.array(z.string()),
      criticalPathLatencyMs: z.number(),
      faultNodeIds: z.array(z.string()),
      affectedNodeIds: z.array(z.string()),
      blastRadiusPct: z.number(),
    }),
  }),
  http: { method: 'GET' },
  readOnly: true,
  link: ({ args }): { url: string; label: string } => ({
    url: buildDeepLink({ view: 'bench', to: `/bench/${encodeURIComponent(args.id)}`, params: { graphId: args.id } }),
    label: 'Open bench',
  }),
  run: async ({ id }) => {
    await assertAccess('service-graph', id, 'viewer');
    const graph = await loadGraph(id);
    const { nodes: nodeRows, links: linkRows } = await loadTopology(graph);
    const nodes = nodeRows.map(toSolverNode);
    const links = linkRows.map(toSolverLink);
    const d = diagnose(graph.domainMode, nodes, links);
    const db = getDb();
    const probes = await db
      .select()
      .from(schema.probeSamples)
      .where(and(eq(schema.probeSamples.graphId, graph.id), eq(schema.probeSamples.ownerEmail, graph.ownerEmail)))
      .orderBy(desc(schema.probeSamples.createdAt))
      .limit(60);
    const frames = await db
      .select()
      .from(schema.incidentFrames)
      .where(and(eq(schema.incidentFrames.graphId, graph.id), eq(schema.incidentFrames.ownerEmail, graph.ownerEmail)))
      .orderBy(asc(schema.incidentFrames.frameSeq))
      .limit(500);
    const gates = await db
      .select()
      .from(schema.rolloutGates)
      .where(and(eq(schema.rolloutGates.graphId, graph.id), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)))
      .orderBy(desc(schema.rolloutGates.createdAt))
      .limit(50);
    const learned = await db
      .select()
      .from(schema.runbookRules)
      .where(eq(schema.runbookRules.ownerEmail, graph.ownerEmail))
      .orderBy(desc(schema.runbookRules.createdAt))
      .limit(20);
    return {
      graph: { id: graph.id, name: graph.name, domainMode: graph.domainMode, agentBlastCapPct: graph.agentBlastCapPct, activeFrameSeq: graph.activeFrameSeq, updatedAt: graph.updatedAt },
      nodes: nodeRows.map((row, i) => {
        const n = nodes[i]!;
        const nd = d.nodes.get(n.id)!;
        return {
          id: n.id,
          key: n.key,
          label: n.label,
          tier: n.tier,
          x: row.posX,
          y: row.posY,
          baseLatencyMs: n.baseLatencyMs,
          effectiveLatencyMs: nd.effectiveLatencyMs,
          errorRatePct: n.errorRatePct,
          failProbability: nd.failProbability,
          nominalVoltageV: n.nominalVoltageV,
          measuredVoltageV: n.measuredVoltageV,
          expectedVoltageV: nd.rail?.expectedVoltageV ?? null,
          currentA: nd.rail?.outputCurrentA ?? null,
          trafficSharePct: n.trafficSharePct,
          status: nd.derivedStatus,
          rootCauseScore: nd.rootCauseScore,
          config: n.config,
        };
      }),
      links: links.map((l) => {
        const e = d.edges.get(l.id);
        return { ...l, currentA: e?.currentA ?? null, dropV: e?.dropV ?? null, dissipationW: e?.dissipationW ?? null };
      }),
      probes: probes.map((p) => ({ id: p.id, nodeId: p.nodeId, metricName: p.metricName, measuredValue: p.measuredValue, unit: p.unit, recordedBy: p.recordedBy, createdAt: p.createdAt })),
      frames: frames.map((f) => ({
        seq: f.frameSeq,
        eventType: f.eventType,
        summary: f.summary,
        blastRadiusPct: f.blastRadiusPct,
        timestampUs: f.timestampUs,
        nodes: JSON.parse(f.snapshotNodesJson) as z.infer<typeof frameNodeSchema>[],
      })),
      gates: gates.map((g) => ({
        id: g.id,
        targetNodeId: g.targetNodeId,
        agentProposedPatch: g.agentProposedPatch,
        operatorFinalPatch: g.operatorFinalPatch,
        patchDiffHash: g.patchDiffHash,
        computedBlastRadiusPct: g.computedBlastRadiusPct,
        affectedNodeIds: JSON.parse(g.affectedNodeIdsJson) as string[],
        requiresHumanShield: g.requiresHumanShield,
        stagedBy: g.stagedBy,
        status: g.status,
        approvedBy: g.approvedBy,
        createdAt: g.createdAt,
      })),
      learnedRules: learned.map((r) => ({ id: r.id, nodeKey: r.nodeKey, rule: r.ruleMd, createdAt: r.createdAt })),
      diagnosis: {
        cyclicSccs: d.cyclic,
        criticalPath: d.criticalPath,
        criticalPathLatencyMs: d.criticalPathLatencyMs,
        faultNodeIds: [...d.faultNodeIds].sort((a, b) => (d.nodes.get(b)?.rootCauseScore ?? 0) - (d.nodes.get(a)?.rootCauseScore ?? 0)),
        affectedNodeIds: d.affectedNodeIds,
        blastRadiusPct: d.blastRadiusPct,
      },
    };
  },
});
