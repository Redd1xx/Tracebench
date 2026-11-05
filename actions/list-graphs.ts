import { defineAction } from '@agent-native/core/action';
import { buildDeepLink } from '@agent-native/core/server';
import { accessFilter } from '@agent-native/core/sharing';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { ensureWorkspace } from '../server/incident/bench.js';

export default defineAction({
  description:
    'List the incident benches (service meshes and PCB power boards) with their latest solved blast radius, fault count, and pending shielded rollouts. Seeds two starter incidents on first visit.',
  schema: z.object({}),
  outputSchema: z.object({
    graphs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        domainMode: z.enum(['distributed_infra', 'hardware_pcb']),
        agentBlastCapPct: z.number(),
        nodeCount: z.number(),
        faultCount: z.number(),
        blastRadiusPct: z.number().nullable(),
        pendingGates: z.number(),
        frameCount: z.number(),
        updatedAt: z.string(),
      }),
    ),
  }),
  http: { method: 'GET' },
  readOnly: true,
  link: (): { url: string; label: string } => ({ url: buildDeepLink({ view: 'bench', to: '/bench' }), label: 'Open TraceBench' }),
  run: async (_args, ctx) => {
    await ensureWorkspace(ctx);
    const { serviceGraphs, serviceGraphShares, graphNodes, incidentFrames, rolloutGates } = schema;
    const db = getDb();
    const graphs = await db
      .select()
      .from(serviceGraphs)
      .where(accessFilter(serviceGraphs, serviceGraphShares))
      .orderBy(desc(serviceGraphs.updatedAt))
      .limit(100);
    const ids = graphs.map((g) => g.id);
    const owners = [...new Set(graphs.map((g) => g.ownerEmail))];
    if (!ids.length) return { graphs: [] };
    const nodes = await db
      .select({ graphId: graphNodes.graphId, status: graphNodes.status })
      .from(graphNodes)
      .where(and(inArray(graphNodes.graphId, ids), inArray(graphNodes.ownerEmail, owners)))
      .limit(5000);
    const frames = await db
      .select({ graphId: incidentFrames.graphId, seq: incidentFrames.frameSeq, blast: incidentFrames.blastRadiusPct })
      .from(incidentFrames)
      .where(and(inArray(incidentFrames.graphId, ids), inArray(incidentFrames.ownerEmail, owners)))
      .limit(10000);
    const gates = await db
      .select({ graphId: rolloutGates.graphId })
      .from(rolloutGates)
      .where(and(inArray(rolloutGates.graphId, ids), inArray(rolloutGates.ownerEmail, owners), eq(rolloutGates.status, 'SHIELDED_PENDING')))
      .limit(1000);
    return {
      graphs: graphs.map((g) => {
        const fs = frames.filter((f) => f.graphId === g.id).sort((a, b) => b.seq - a.seq);
        return {
          id: g.id,
          name: g.name,
          domainMode: g.domainMode,
          agentBlastCapPct: g.agentBlastCapPct,
          nodeCount: nodes.filter((n) => n.graphId === g.id).length,
          faultCount: nodes.filter((n) => n.graphId === g.id && n.status === 'FAULT').length,
          blastRadiusPct: fs[0]?.blast ?? null,
          pendingGates: gates.filter((x) => x.graphId === g.id).length,
          frameCount: fs.length,
          updatedAt: g.updatedAt,
        };
      }),
    };
  },
});
