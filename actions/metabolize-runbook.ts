import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defineAction, fail } from '@agent-native/core/action';
import { assertAccess } from '@agent-native/core/sharing';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { parsePatch } from '../app/lib/solver/patch';
import { getDb, schema } from '../server/db/index.js';
import { loadGraph, loadTopology, nowIso } from '../server/incident/bench.js';
import { keyDeltas, unifiedPatchDiff } from '../server/incident/patch-diff.js';

const SKILL_PATH = '.agents/skills/incident-runbooks/SKILL.md';

const SKILL_HEADER = `---
name: incident-runbooks
description: >-
  Remediation rules learned when operators hand-edited agent patches before
  approving them in TraceBench's Shielded Gate. Read before stage-patch.
scope: both
---

# Incident Runbooks

Each rule comes from a real diff between \`agent_proposed_patch\` and the
operator's \`operator_final_patch\`, written by \`metabolize-runbook\`.

No rules below this line means none have been learned yet: draft from first principles.
`;

export default defineAction({
  description:
    "Hand edits are runbook gold: diff a gate's agent_proposed_patch against the operator's operator_final_patch (unified line diff + key-path deltas) and append the learned remediation constraint to .agents/skills/incident-runbooks/SKILL.md so the next agent patch starts from the operator's judgment.",
  schema: z.object({
    graphId: z.string().describe('Graph id'),
    gateId: z.string().describe('Rollout gate whose patch the operator edited'),
  }),
  outputSchema: z.object({
    gateId: z.string(),
    unifiedDiff: z.string(),
    deltas: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })),
    rule: z.string(),
    ruleId: z.string(),
    skillPath: z.string(),
    skillFileWritten: z.boolean(),
  }),
  mcpAnnotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  changeResource: (input) => ({ resourceType: 'service-graph', resourceId: input.graphId }),
  run: async ({ graphId, gateId }) => {
    await assertAccess('service-graph', graphId, 'editor');
    const graph = await loadGraph(graphId);
    const [gate] = await getDb()
      .select()
      .from(schema.rolloutGates)
      .where(and(eq(schema.rolloutGates.id, gateId), eq(schema.rolloutGates.graphId, graph.id), eq(schema.rolloutGates.ownerEmail, graph.ownerEmail)))
      .limit(1);
    if (!gate) fail('Rollout gate not found.', { errorCode: 'not_found', statusCode: 404 });
    if (!gate.operatorFinalPatch || gate.operatorFinalPatch.trim() === gate.agentProposedPatch.trim()) {
      fail('The operator has not hand-edited this patch; nothing to learn.', { errorCode: 'no_operator_edit', statusCode: 409 });
    }
    const before = parsePatch(gate.agentProposedPatch);
    const after = parsePatch(gate.operatorFinalPatch);
    const { nodes } = await loadTopology(graph);
    const target = nodes.find((n) => n.id === gate.targetNodeId);
    const diff = unifiedPatchDiff(gate.agentProposedPatch, gate.operatorFinalPatch, target?.nodeKey ?? 'patch');
    const deltas = keyDeltas(before.ok ? before.patch : {}, after.ok ? after.patch : {});
    const lines: string[] = [];
    if (before.ok && after.ok && before.patch.kind !== after.patch.kind) {
      lines.push(`- For \`${target?.nodeKey}\` (${target?.tier}) the operator chose \`${after.patch.kind}\` over the agent's \`${before.patch.kind}\`.`);
    }
    if (before.ok && after.ok && before.patch.target !== after.patch.target) {
      lines.push(`- The operator retargeted the patch from \`${before.patch.target}\` to \`${after.patch.target}\`: fix at that node instead.`);
    }
    for (const d of deltas) {
      if (d.path === 'kind' || d.path === 'target' || d.path === 'note') continue;
      const b = typeof d.before === 'number' ? d.before : null;
      const a = typeof d.after === 'number' ? d.after : null;
      if (b !== null && a !== null) {
        lines.push(`- \`${d.path}\`: agent proposed ${b}, operator set ${a} (${a > b ? '+' : ''}${Math.round(((a - b) / (b || 1)) * 100)}%). Start from the operator's value on \`${target?.nodeKey}\`.`);
      } else {
        lines.push(`- \`${d.path}\`: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}.`);
      }
    }
    lines.push(`- Gate context: blast radius ${gate.computedBlastRadiusPct}% on graph "${graph.name}" (${graph.domainMode}); shield ${gate.requiresHumanShield ? 'required' : 'not required'}.`);
    const rule = lines.join('\n');
    const ruleId = crypto.randomUUID();
    await getDb().insert(schema.runbookRules).values({
      id: ruleId,
      graphId: graph.id,
      gateId: gate.id,
      nodeKey: target?.nodeKey ?? 'node',
      ruleMd: rule,
      unifiedDiff: diff,
      createdAt: nowIso(),
      ownerEmail: graph.ownerEmail,
      orgId: graph.orgId,
      visibility: graph.visibility,
    });
    let skillFileWritten = false;
    try {
      const skillDocPath = path.join(process.cwd(), SKILL_PATH);
      await mkdir(path.dirname(skillDocPath), { recursive: true });
      const currentDoc = await readFile(skillDocPath, 'utf8').catch(() => '');
      if (!currentDoc) await writeFile(skillDocPath, SKILL_HEADER, 'utf8');
      await appendFile(skillDocPath, ['', `## ${target?.nodeKey ?? 'node'} — ${nowIso().slice(0, 10)}`, '', rule, '', '```diff', diff, '```', ''].join('\n'), 'utf8');
      skillFileWritten = true;
    } catch {
      skillFileWritten = false;
    }
    return { gateId: gate.id, unifiedDiff: diff, deltas, rule, ruleId, skillPath: SKILL_PATH, skillFileWritten };
  },
});
