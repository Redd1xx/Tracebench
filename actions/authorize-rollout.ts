import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { applyPatch, canonicalPatch, parsePatch, patchImpact } from '../app/lib/solver/patch';
import { getDb, schema } from '../server/db/index.js';
import { acceptedCountersign, isOperatorUi, requiresShield, rolloutVerdict } from '../server/incident/gate.js';
import { loadGraph, loadTopology, requireUser, sha256, solveAndRecord, toSolverLink, toSolverNode } from '../server/incident/bench.js';

export default defineAction({
  description:
    "Scoped Agent Blast-Radius Gate. Executes a staged patch. If the gate requires a human shield (blast radius > agent cap or CRITICAL_TIER_1 target), execution needs human_countersigned plus the exact patch_diff_hash — and a countersignature only counts when it comes from a signed-in operator in the app UI. An agent, MCP, A2A or CLI caller cannot countersign; such calls fail with BLAST_RADIUS_CAP_EXCEEDED (409). The operator may hand-edit the patch first (operatorFinalPatch), which re-computes the blast radius and hash. On success the patch is applied, the solver re-runs and a rollout frame is recorded.",
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    gateId: z.string().describe('Rollout gate id from stage-patch / get-graph-state'),
    humanCountersigned: z.boolean().describe('True only when a human operator approves in the Shielded Gate UI'),
    patchDiffHash: z.string().optional().describe('SHA-256 of the exact patch being approved (required with a countersignature)'),
    operatorFinalPatch: z.string().max(4000).optional().describe('Operator hand-edited patch JSON that replaces the agent draft (UI only)'),
  }),
  outputSchema: z.object({
    gateId: z.string(),
    status: z.literal('APPROVED_APPLIED'),
    approvedBy: z.string(),
    appliedPatchHash: z.string(),
    summary: z.string(),
    frameSeq: z.number(),
    blastRadiusAfterPct: z.number(),
    faultsAfter: z.array(z.string()),
  }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async (args, ctx) => {
    await assertAccess('service-graph', args.graphId, 'editor');
    const graph = await loadGraph(args.graphId);
    const { ownerEmail: actor } = requireUser(ctx);
    // Scoped identity: only a request proven to come from the app UI is a human.
    const fromOperatorUi = isOperatorUi(ctx?.caller);
    const countersigned = acceptedCountersign(args.humanCountersigned, ctx?.caller);
    const db = getDb();
    const [gate] = await db
      .select()
      .from(schema.rolloutGates)
      .where(and(eq(schema.rolloutGates.id, args.gateId), eq(schema.rolloutGates.graphId, graph.id), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)))
      .limit(1);
    if (!gate) fail('Rollout gate not found.', { errorCode: 'not_found', statusCode: 404 });
    if (gate.status !== 'SHIELDED_PENDING') fail(`Gate is already ${gate.status}.`, { errorCode: 'gate_closed', statusCode: 409 });

    const { nodes: rows, links: linkRows } = await loadTopology(graph);
    const nodes = rows.map(toSolverNode);
    const links = linkRows.map(toSolverLink);

    let patchText = gate.operatorFinalPatch ?? gate.agentProposedPatch;
    let hash = gate.patchDiffHash;
    let shield = gate.requiresHumanShield;
    if (args.operatorFinalPatch !== undefined && args.operatorFinalPatch.trim() !== patchText.trim()) {
      if (!fromOperatorUi) fail('Only an operator in the app can hand-edit a staged patch.', { errorCode: 'OPERATOR_ONLY', statusCode: 403 });
      const edited = parsePatch(args.operatorFinalPatch);
      if (!edited.ok) fail(`Invalid operator patch: ${edited.error}`, { errorCode: 'invalid_patch' });
      const impact = patchImpact(edited.patch, nodes, links);
      if (!impact) fail('Operator patch targets an unknown node.', { errorCode: 'node_not_found', statusCode: 404 });
      const target = nodes.find((n) => n.id === impact.targetNodeId)!;
      patchText = JSON.stringify(edited.patch, null, 2);
      hash = sha256(canonicalPatch(patchText));
      shield = requiresShield(impact.blastRadiusPct, graph.agentBlastCapPct, target.tier);
      await db
        .update(schema.rolloutGates)
        .set({
          operatorFinalPatch: patchText,
          patchDiffHash: hash,
          computedBlastRadiusPct: impact.blastRadiusPct,
          affectedNodeIdsJson: JSON.stringify(impact.affectedNodeIds),
          requiresHumanShield: shield,
          targetNodeId: target.id,
        })
        .where(and(eq(schema.rolloutGates.id, gate.id), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)));
    }

    const verdict = rolloutVerdict({ shield, humanCountersigned: args.humanCountersigned, caller: ctx?.caller, providedHash: args.patchDiffHash, currentHash: hash });
    if (!verdict.allowed) {
      fail('Blast radius exceeds 15% autonomous agent cap; human Shielded Gate approval required', {
        errorCode: 'BLAST_RADIUS_CAP_EXCEEDED',
        statusCode: 409,
        details: {
          gateId: gate.id,
          computedBlastRadiusPct: gate.computedBlastRadiusPct,
          agentBlastCapPct: graph.agentBlastCapPct,
          countersignatureAccepted: verdict.countersignatureAccepted,
          hashMatches: verdict.hashMatches,
        },
      });
    }

    const parsed = parsePatch(patchText);
    if (!parsed.ok) fail(`Stored patch is invalid: ${parsed.error}`, { errorCode: 'invalid_patch' });
    const applied = applyPatch(parsed.patch, nodes, links, graph.domainMode);
    await db.transaction(async (tx) => {
      for (const n of applied.nodes) {
        const before = nodes.find((x) => x.id === n.id)!;
        if (JSON.stringify(before) === JSON.stringify(n)) continue;
        await tx
          .update(schema.graphNodes)
          .set({
            baseLatencyMs: n.baseLatencyMs,
            errorRatePct: n.errorRatePct,
            trafficSharePct: n.trafficSharePct,
            status: n.status,
            configJson: JSON.stringify(n.config),
          })
          .where(and(eq(schema.graphNodes.id, n.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail)));
      }
      for (const l of applied.links) {
        const before = links.find((x) => x.id === l.id)!;
        if (before.targetNodeId === l.targetNodeId && before.status === l.status) continue;
        await tx
          .update(schema.graphLinks)
          .set({ targetNodeId: l.targetNodeId, status: l.status })
          .where(and(eq(schema.graphLinks.id, l.id), eq(schema.graphLinks.ownerEmail, graph.ownerEmail)));
      }
      await tx
        .update(schema.rolloutGates)
        .set({ status: 'APPROVED_APPLIED', approvedBy: countersigned ? actor : 'agent:autonomous' })
        .where(and(eq(schema.rolloutGates.id, gate.id), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)));
    });
    const approvedBy = countersigned ? actor : 'agent:autonomous';
    const { diagnosis, frameSeq } = await solveAndRecord(graph, 'rollout', `Rollout ${applied.summary} · approved by ${approvedBy}`);
    return {
      gateId: gate.id,
      status: 'APPROVED_APPLIED' as const,
      approvedBy,
      appliedPatchHash: hash,
      summary: applied.summary,
      frameSeq,
      blastRadiusAfterPct: diagnosis.blastRadiusPct,
      faultsAfter: diagnosis.faultNodeIds.map((id) => nodes.find((n) => n.id === id)?.key ?? id),
    };
  },
});
