import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { loadGraph, requireUser } from '../server/incident/bench.js';

const RejectGateInput = z.object({
  graphId: z.string().describe('Graph id'),
  gateId: z.string().describe('Rollout gate id (status SHIELDED_PENDING)'),
});

export default defineAction({
  description: 'Reject a pending rollout gate so the staged patch can never execute.',
  schema: RejectGateInput,
  outputSchema: z.object({ gateId: z.string(), status: z.literal('REJECTED') }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  changeResource: ({ graphId }) => ({ resourceType: 'service-graph', resourceId: graphId }),
  run: async (params, ctx) => {
    await assertAccess('service-graph', params.graphId, 'editor');
    const bench = await loadGraph(params.graphId);
    const operator = requireUser(ctx).ownerEmail;
    const db = getDb();

    const existing = await db
      .select({ id: schema.rolloutGates.id, status: schema.rolloutGates.status })
      .from(schema.rolloutGates)
      .where(
        and(
          eq(schema.rolloutGates.id, params.gateId),
          eq(schema.rolloutGates.graphId, bench.id),
          eq(schema.rolloutGates.ownerEmail, bench.ownerEmail),
        ),
      );

    if (!existing[0] || existing[0].status !== 'SHIELDED_PENDING') {
      fail('No pending gate with that id.', { errorCode: 'gate_closed', statusCode: 409 });
    }

    await db
      .update(schema.rolloutGates)
      .set({ status: 'REJECTED', approvedBy: operator })
      .where(eq(schema.rolloutGates.id, existing[0].id));

    return { gateId: existing[0].id, status: 'REJECTED' as const };
  },
});
