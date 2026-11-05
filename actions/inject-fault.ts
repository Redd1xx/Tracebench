import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { loadGraph, loadTopology, solveAndRecord } from '../server/incident/bench.js';

export default defineAction({
  description:
    'Chaos injection for drills: set an error burst (error rate %), a latency spike (base latency ms), a rail short (ohms across the rail output), cut a dependency link, or recover a node to its baseline. The solver re-runs and a chaos frame is recorded on the timeline.',
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    nodeId: z.string().describe('Node id or key to inject into'),
    fault: z.enum(['error_burst', 'latency_spike', 'rail_short', 'cut_dependencies', 'recover']).describe('Fault type'),
    value: z.number().min(0).optional().describe('error_burst: %, latency_spike: ms, rail_short: ohms; unused for cut/recover'),
  }),
  outputSchema: z.object({ nodeKey: z.string(), fault: z.string(), frameSeq: z.number(), blastRadiusPct: z.number(), faults: z.array(z.string()) }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async (args) => {
    await assertAccess('service-graph', args.graphId, 'editor');
    const graph = await loadGraph(args.graphId);
    const { nodes, links } = await loadTopology(graph);
    const node = nodes.find((n) => n.id === args.nodeId || n.nodeKey === args.nodeId);
    if (!node) fail('Node not found on this graph.', { errorCode: 'node_not_found', statusCode: 404 });
    if (args.fault === 'rail_short' && graph.domainMode !== 'hardware_pcb') fail('Rail shorts apply to hardware boards.', { errorCode: 'fault_not_applicable' });
    if (['error_burst', 'latency_spike', 'rail_short'].includes(args.fault) && args.value === undefined) {
      fail('This fault needs a value.', { errorCode: 'missing_value' });
    }
    const config = JSON.parse(node.configJson) as Record<string, unknown>;
    const db = getDb();
    await db.transaction(async (tx) => {
      const where = and(eq(schema.graphNodes.id, node.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail));
      if (args.fault === 'error_burst') await tx.update(schema.graphNodes).set({ errorRatePct: Math.min(100, args.value!) }).where(where);
      if (args.fault === 'latency_spike') await tx.update(schema.graphNodes).set({ baseLatencyMs: args.value! }).where(where);
      if (args.fault === 'rail_short') await tx.update(schema.graphNodes).set({ configJson: JSON.stringify({ ...config, shortOhms: Math.max(0.001, args.value!) }) }).where(where);
      if (args.fault === 'recover') {
        const rest = { ...config };
        delete rest.shortOhms;
        await tx
          .update(schema.graphNodes)
          .set({ errorRatePct: typeof config.baselineErrorRatePct === 'number' ? config.baselineErrorRatePct : 0, status: 'HEALTHY', configJson: JSON.stringify(rest), measuredVoltageV: null })
          .where(where);
      }
      if (args.fault === 'cut_dependencies') {
        for (const l of links.filter((x) => x.sourceNodeId === node.id)) {
          await tx.update(schema.graphLinks).set({ status: 'CUT' }).where(and(eq(schema.graphLinks.id, l.id), eq(schema.graphLinks.ownerEmail, graph.ownerEmail)));
        }
      }
    });
    const { diagnosis, frameSeq } = await solveAndRecord(graph, 'chaos', `Chaos ${args.fault} on ${node.nodeKey}${args.value !== undefined ? ` (${args.value})` : ''}`);
    return {
      nodeKey: node.nodeKey,
      fault: args.fault,
      frameSeq,
      blastRadiusPct: diagnosis.blastRadiusPct,
      faults: diagnosis.faultNodeIds.map((id) => nodes.find((n) => n.id === id)?.nodeKey ?? id),
    };
  },
});
