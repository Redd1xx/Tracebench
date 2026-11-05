import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { canonicalPatch, parsePatch, patchImpact } from '../app/lib/solver/patch';
import { getDb, schema } from '../server/db/index.js';
import { sidesFromUnifiedDiff } from '../server/incident/patch-diff.js';
import { type LearnedEdit, applyRunbookBounds } from '../server/incident/runbook-bounds.js';
import { loadGraph, loadTopology, nowIso, sha256, solveAndRecord, toSolverLink, toSolverNode } from '../server/incident/bench.js';

export default defineAction({
  description:
    'Stage a remediation patch against a node. Patch is JSON: {"kind":"config"|"isolate"|"restart"|"reroute","target":"<node key>","set":{"baseLatencyMs"?,"errorRatePct"?,"trafficSharePct"?,"config"?:{...}},"fallback"?:"<node key>","note"?}. The solver computes the exact blast_radius_pct of the change (isolate/restart hit every dependent; config/reroute reach dependents coupled ≥ 0.35) and its SHA-256 patch_diff_hash. requires_human_shield is set when blast radius > the graph\'s agent cap (15%) or the target is CRITICAL_TIER_1. Agent patches are first bounded by learned runbook rules: a numeric value an operator previously raised or lowered on the same node and kind is moved to the operator\'s value; runbookAdjustments lists each change, so cite them.',
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    patch: z.string().min(10).max(4000).describe('Patch JSON document (see description)'),
    stagedBy: z.enum(['agent', 'operator']).describe('"agent" when the AI drafts it, "operator" for a human'),
  }),
  outputSchema: z.object({
    id: z.string(),
    targetKey: z.string(),
    computedBlastRadiusPct: z.number(),
    agentBlastCapPct: z.number(),
    requiresHumanShield: z.boolean(),
    shieldReasons: z.array(z.string()),
    patchDiffHash: z.string(),
    affectedKeys: z.array(z.string()),
    nextRequiredAction: z.string(),
    graphId: z.string(),
    graphName: z.string(),
    targetLabel: z.string(),
    targetTier: z.string(),
    stagedBy: z.string(),
    runbookAdjustments: z.array(z.object({ ruleId: z.string(), path: z.string(), proposed: z.number(), applied: z.number() })),
  }),
  // The app's own chat shows the gate verdict as a card rather than a raw tool row.
  chatUI: { renderer: 'tracebench.shield-verdict' },
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async (args) => {
    await assertAccess('service-graph', args.graphId, 'editor');
    const graph = await loadGraph(args.graphId);
    const parsed = parsePatch(args.patch);
    if (!parsed.ok) fail(`Invalid patch: ${parsed.error}`, { errorCode: 'invalid_patch' });
    const { nodes: rows, links: linkRows } = await loadTopology(graph);
    const nodes = rows.map(toSolverNode);
    const bounded = args.stagedBy === 'agent' ? applyRunbookBounds(parsed.patch, await learnedEdits(graph.ownerEmail)) : { patch: parsed.patch, adjustments: [] };
    const patch = bounded.patch;
    const impact = patchImpact(patch, nodes, linkRows.map(toSolverLink));
    if (!impact) fail(`Patch target "${patch.target}" is not a node key on this graph.`, { errorCode: 'node_not_found', statusCode: 404 });
    const target = nodes.find((n) => n.id === impact.targetNodeId)!;
    const reasons: string[] = [];
    if (impact.blastRadiusPct > graph.agentBlastCapPct) reasons.push(`blast radius ${impact.blastRadiusPct}% > ${graph.agentBlastCapPct}% agent cap`);
    if (target.tier === 'CRITICAL_TIER_1') reasons.push(`target ${target.key} is CRITICAL_TIER_1`);
    const pretty = JSON.stringify(patch, null, 2);
    const hash = sha256(canonicalPatch(pretty));
    const id = crypto.randomUUID();
    await getDb().insert(schema.rolloutGates).values({
      id,
      graphId: graph.id,
      targetNodeId: target.id,
      agentProposedPatch: pretty,
      patchDiffHash: hash,
      computedBlastRadiusPct: impact.blastRadiusPct,
      affectedNodeIdsJson: JSON.stringify(impact.affectedNodeIds),
      requiresHumanShield: reasons.length > 0,
      stagedBy: args.stagedBy,
      createdAt: nowIso(),
      ownerEmail: graph.ownerEmail,
      orgId: graph.orgId,
      visibility: graph.visibility,
    });
    await solveAndRecord(graph, 'patch_staged', `Patch staged on ${target.key} (${patch.kind}) · blast ${impact.blastRadiusPct}%${reasons.length ? ' · SHIELDED' : ''}${runbookNote(bounded.adjustments)}`);
    return {
      id,
      targetKey: target.key,
      computedBlastRadiusPct: impact.blastRadiusPct,
      agentBlastCapPct: graph.agentBlastCapPct,
      requiresHumanShield: reasons.length > 0,
      shieldReasons: reasons,
      patchDiffHash: hash,
      affectedKeys: impact.affectedNodeIds.map((nid) => nodes.find((n) => n.id === nid)?.key ?? nid),
      nextRequiredAction: reasons.length ? 'ask the operator to countersign in the Shielded Gate' : 'authorize-rollout',
      graphId: graph.id,
      graphName: graph.name,
      targetLabel: target.label,
      targetTier: target.tier,
      stagedBy: args.stagedBy,
      runbookAdjustments: bounded.adjustments,
    };
  },
});

function runbookNote(adjustments: { path: string; proposed: number; applied: number }[]): string {
  if (!adjustments.length) return '';
  return ` · runbook ${adjustments.map((a) => `${a.path.slice(a.path.lastIndexOf('.') + 1)} ${a.proposed}→${a.applied}`).join(', ')}`;
}

// Operator edits the owner has metabolized, newest first, rebuilt from each rule's full-context diff
// (gates are cleared on bench reset; rules are not).
async function learnedEdits(ownerEmail: string): Promise<LearnedEdit[]> {
  const rules = await getDb()
    .select({ id: schema.runbookRules.id, unifiedDiff: schema.runbookRules.unifiedDiff })
    .from(schema.runbookRules)
    .where(eq(schema.runbookRules.ownerEmail, ownerEmail))
    .orderBy(desc(schema.runbookRules.createdAt))
    .limit(50);
  return rules.flatMap((r) => {
    const { before, after } = sidesFromUnifiedDiff(r.unifiedDiff);
    const a = parsePatch(before);
    const b = parsePatch(after);
    return a.ok && b.ok ? [{ ruleId: r.id, agentPatch: a.patch, operatorPatch: b.patch }] : [];
  });
}
