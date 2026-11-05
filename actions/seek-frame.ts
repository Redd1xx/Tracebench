import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { type FrameNode, loadGraph, nowIso, solveAndRecord } from '../server/incident/bench.js';

export default defineAction({
  description:
    'Scrub the incident timeline to a frame. By default it previews: the bench shows that frame\'s exact historical node states and blast heatmap while live data is untouched. With restore: true the frame\'s inputs (error rates, latencies, rail readings, isolation, link cuts, config) are written back as the live state and a new "restore" frame is appended — history itself is never rewritten.',
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    frameSeq: z.number().int().min(0).describe('Frame sequence number to seek to'),
    restore: z.boolean().optional().describe('Write the frame back as live state (default false = preview only)'),
  }),
  outputSchema: z.object({
    graphId: z.string(),
    activeFrameSeq: z.number(),
    eventType: z.string(),
    summary: z.string(),
    blastRadiusPct: z.number(),
    restored: z.boolean(),
    newFrameSeq: z.number().nullable(),
  }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async ({ graphId, frameSeq, restore }) => {
    await assertAccess('service-graph', graphId, restore ? 'editor' : 'viewer');
    const graph = await loadGraph(graphId);
    const db = getDb();
    const [frame] = await db
      .select()
      .from(schema.incidentFrames)
      .where(and(eq(schema.incidentFrames.graphId, graph.id), eq(schema.incidentFrames.ownerEmail, graph.ownerEmail), eq(schema.incidentFrames.frameSeq, frameSeq)))
      .limit(1);
    if (!frame) fail(`Frame ${frameSeq} does not exist on this timeline.`, { errorCode: 'frame_not_found', statusCode: 404 });
    if (!restore) {
      await db
        .update(schema.serviceGraphs)
        .set({ activeFrameSeq: frameSeq, updatedAt: nowIso() })
        .where(and(eq(schema.serviceGraphs.id, graph.id), eq(schema.serviceGraphs.ownerEmail, graph.ownerEmail)));
      return { graphId: graph.id, activeFrameSeq: frameSeq, eventType: frame.eventType, summary: frame.summary, blastRadiusPct: frame.blastRadiusPct, restored: false, newFrameSeq: null };
    }
    const snapshot = JSON.parse(frame.snapshotNodesJson) as FrameNode[];
    const links = JSON.parse(frame.snapshotLinksJson) as { id: string; status: 'ACTIVE' | 'CUT'; targetNodeId: string }[];
    await db.transaction(async (tx) => {
      for (const n of snapshot) {
        await tx
          .update(schema.graphNodes)
          .set({
            errorRatePct: n.errorRatePct,
            baseLatencyMs: n.baseLatencyMs,
            measuredVoltageV: n.measuredVoltageV,
            configJson: JSON.stringify(n.config),
            status: n.status === 'ISOLATED' ? 'ISOLATED' : 'HEALTHY',
          })
          .where(and(eq(schema.graphNodes.id, n.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail)));
      }
      for (const l of links) {
        await tx
          .update(schema.graphLinks)
          .set({ status: l.status, targetNodeId: l.targetNodeId })
          .where(and(eq(schema.graphLinks.id, l.id), eq(schema.graphLinks.ownerEmail, graph.ownerEmail)));
      }
    });
    const { diagnosis, frameSeq: newSeq } = await solveAndRecord(graph, 'restore', `Restored live state to frame #${frameSeq} (${frame.eventType})`);
    return { graphId: graph.id, activeFrameSeq: newSeq, eventType: 'restore', summary: frame.summary, blastRadiusPct: diagnosis.blastRadiusPct, restored: true, newFrameSeq: newSeq };
  },
});
