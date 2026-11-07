import fs from 'node:fs/promises';
import path from 'node:path';

import { defineAction } from '@agent-native/core/action';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, schema } from '../server/db/index.js';
import { ensureWorkspace, requireUser } from '../server/incident/bench.js';

async function truncateAppendedRunbookEntries(): Promise<boolean> {
  const skillFile = path.resolve(process.cwd(), '.agents', 'skills', 'incident-runbooks', 'SKILL.md');
  try {
    const rawLines = (await fs.readFile(skillFile, 'utf8')).split('\n');
    const firstAppendedHeading = rawLines.findIndex((line, idx) => idx > 0 && line.startsWith('## '));
    if (firstAppendedHeading > 0) {
      const headerPortion = rawLines.slice(0, firstAppendedHeading).join('\n').trimEnd();
      await fs.writeFile(skillFile, `${headerPortion}\n`, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

export default defineAction({
  description: 'Reinitialize both incident benches to frame 0, clearing probes, timeline frames, and staged rollout gates.',
  schema: z.object({
    retainRunbook: z.boolean().optional().describe('Retain metabolized runbook rules across bench reinitialization'),
  }),
  outputSchema: z.object({ benchCount: z.number(), clearedRunbookMd: z.boolean() }),
  agentTool: false,
  uiOnly: true,
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  run: async (input, ctx) => {
    const keepRules = Boolean(input.retainRunbook);
    const { ownerEmail } = requireUser(ctx);
    const database = getDb();

    const priorGraphs = await database
      .select({ id: schema.serviceGraphs.id })
      .from(schema.serviceGraphs)
      .where(eq(schema.serviceGraphs.ownerEmail, ownerEmail));

    await database.transaction(async (tx) => {
      if (priorGraphs.length > 0) {
        await tx.delete(schema.serviceGraphShares).where(
          inArray(
            schema.serviceGraphShares.resourceId,
            priorGraphs.map((item) => item.id),
          ),
        );
      }
      if (!keepRules) {
        await tx.delete(schema.runbookRules).where(eq(schema.runbookRules.ownerEmail, ownerEmail));
      }
      await tx.delete(schema.rolloutGates).where(eq(schema.rolloutGates.ownerEmail, ownerEmail));
      await tx.delete(schema.incidentFrames).where(eq(schema.incidentFrames.ownerEmail, ownerEmail));
      await tx.delete(schema.probeSamples).where(eq(schema.probeSamples.ownerEmail, ownerEmail));
      await tx.delete(schema.graphLinks).where(eq(schema.graphLinks.ownerEmail, ownerEmail));
      await tx.delete(schema.graphNodes).where(eq(schema.graphNodes.ownerEmail, ownerEmail));
      await tx.delete(schema.serviceGraphs).where(eq(schema.serviceGraphs.ownerEmail, ownerEmail));
    });

    await ensureWorkspace(ctx);
    const clearedRunbookMd = keepRules ? false : await truncateAppendedRunbookEntries();
    const active = await database
      .select({ id: schema.serviceGraphs.id })
      .from(schema.serviceGraphs)
      .where(eq(schema.serviceGraphs.ownerEmail, ownerEmail));
    return { benchCount: active.length, clearedRunbookMd };
  },
});
