import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { loadGraph, loadTopology, nowIso, solveAndRecord } from '../server/incident/bench.js';

const METRICS = {
  voltage_v: 'V',
  p99_latency_ms: 'ms',
  error_rate_pct: '%',
  pool_saturation_pct: '%',
  current_a: 'A',
} as const;

export default defineAction({
  description:
    'Log a diagnostic probe reading on a node (a multimeter voltage, p99 latency sample, error rate, connection-pool saturation, or load current). The reading becomes the node\'s observed input, the solver re-runs (fault probabilities, voltages, blast radius), and a new timeline frame is appended.',
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    nodeId: z.string().describe('Node id (or node key) the probe touched'),
    metricName: z.enum(['voltage_v', 'p99_latency_ms', 'error_rate_pct', 'pool_saturation_pct', 'current_a']).describe('What was measured'),
    value: z.number().describe('Measured value in the metric\'s unit (V, ms, %, %, A)'),
    recordedBy: z.enum(['operator', 'agent_probe']).describe('"operator" for a human reading, "agent_probe" for an agent-run probe'),
  }),
  outputSchema: z.object({
    id: z.string(),
    nodeKey: z.string(),
    frameSeq: z.number(),
    nodeStatus: z.string(),
    failProbability: z.number(),
    expectedVoltageV: z.number().nullable(),
    blastRadiusPct: z.number(),
    faults: z.array(z.string()),
  }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async (args) => {
    await assertAccess('service-graph', args.graphId, 'editor');
    const graph = await loadGraph(args.graphId);
    const { nodes } = await loadTopology(graph);
    const node = nodes.find((n) => n.id === args.nodeId || n.nodeKey === args.nodeId);
    if (!node) fail('Node not found on this graph.', { errorCode: 'node_not_found', statusCode: 404 });
    if (args.metricName === 'voltage_v' && graph.domainMode !== 'hardware_pcb') {
      fail('Voltage probes apply to hardware boards.', { errorCode: 'metric_not_applicable' });
    }
    if (!Number.isFinite(args.value) || args.value < 0) fail('Probe value must be a non-negative number.', { errorCode: 'invalid_value' });
    const config = JSON.parse(node.configJson) as Record<string, unknown>;
    const patch: Partial<typeof schema.graphNodes.$inferInsert> = {};
    if (args.metricName === 'voltage_v') patch.measuredVoltageV = args.value;
    if (args.metricName === 'p99_latency_ms') patch.baseLatencyMs = args.value;
    if (args.metricName === 'error_rate_pct') patch.errorRatePct = Math.min(100, args.value);
    if (args.metricName === 'current_a') config.loadCurrentA = args.value;
    if (args.metricName === 'pool_saturation_pct') {
      config.poolSaturationPct = args.value;
      if (typeof config.poolMax === 'number') config.poolInUse = Math.round((config.poolMax * Math.min(100, args.value)) / 100);
    }
    patch.configJson = JSON.stringify(config);
    const db = getDb();
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(schema.probeSamples).values({
        id,
        graphId: graph.id,
        nodeId: node.id,
        metricName: args.metricName,
        measuredValue: args.value,
        unit: METRICS[args.metricName],
        recordedBy: args.recordedBy,
        createdAt: nowIso(),
        ownerEmail: graph.ownerEmail,
        orgId: graph.orgId,
        visibility: graph.visibility,
      });
      await tx.update(schema.graphNodes).set(patch).where(and(eq(schema.graphNodes.id, node.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail)));
    });
    const { diagnosis, frameSeq } = await solveAndRecord(graph, 'probe', `${args.recordedBy === 'operator' ? 'Operator' : 'Agent'} probe ${node.nodeKey} ${args.metricName}=${args.value}${METRICS[args.metricName]}`);
    const nd = diagnosis.nodes.get(node.id)!;
    return {
      id,
      nodeKey: node.nodeKey,
      frameSeq,
      nodeStatus: nd.derivedStatus,
      failProbability: nd.failProbability,
      expectedVoltageV: nd.rail?.expectedVoltageV ?? null,
      blastRadiusPct: diagnosis.blastRadiusPct,
      faults: diagnosis.faultNodeIds.map((f) => nodes.find((n) => n.id === f)?.nodeKey ?? f),
    };
  },
});
