import { getOrgContext } from '@agent-native/core/org';
import { createAgentChatPlugin, loadActionsFromStaticRegistry } from '@agent-native/core/server';

import { desc, eq } from 'drizzle-orm';
import { createError } from 'h3';

import actionsRegistry from '../../.generated/actions-registry.js';
import { getDb, schema } from '../db/index.js';

let bucketTokens = -1;
let lastRefillEpochMs = 0;

function consumePromptToken(ctx: { internalContinuation?: boolean; isBackgroundWorker?: boolean }) {
  if (ctx.internalContinuation || ctx.isBackgroundWorker) return;
  const capacityPerHour = parseInt(
    process.env.TRACEBENCH_MAX_RUNS_PER_HOUR ?? (process.env.VERCEL ? '60' : '0'), // guard:allow-env-credential — token-bucket prompt rate
    10,
  );
  if (!(capacityPerHour > 0)) return;
  const nowMs = Date.now();
  if (bucketTokens < 0) {
    bucketTokens = capacityPerHour;
    lastRefillEpochMs = nowMs;
  } else {
    const elapsedHours = (nowMs - lastRefillEpochMs) / 3_600_000;
    if (elapsedHours > 0) {
      bucketTokens = Math.min(capacityPerHour, bucketTokens + elapsedHours * capacityPerHour);
      lastRefillEpochMs = nowMs;
    }
  }
  if (bucketTokens < 1) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Hourly agent cap reached',
      message: `Hosted bench caps agent runs at ${capacityPerHour} per hour. Manual probing, fault injection, and timeline replay remain unrestricted.`,
    });
  }
  bucketTokens -= 1;
}

const INITIAL_TOOL_NAMES = [
  'view-screen',
  'navigate',
  'list-graphs',
  'get-graph-state',
  'log-probe',
  'compute-blast-radius',
  'stage-patch',
  'authorize-rollout',
  'metabolize-runbook',
  'seek-frame',
  'inject-fault',
  'ask-question',
];

export default createAgentChatPlugin({
  appId: 'tracebench',
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: {
    connectorCatalog: [],
    appApprovalPage: true,
    keyToolNames: [
      'list-graphs',
      'get-graph-state',
      'compute-blast-radius',
      'stage-patch',
      'authorize-rollout',
      'metabolize-runbook',
      'seek-frame',
    ],
  },
  initialToolNames: INITIAL_TOOL_NAMES,
  prepareRequest: (details) => consumePromptToken(details),
  // Attach metabolized runbook rules from previous incidents to each turn.
  extraContext: async (_event, owner) => {
    const rules = await getDb()
      .select({ nodeKey: schema.runbookRules.nodeKey, ruleMd: schema.runbookRules.ruleMd })
      .from(schema.runbookRules)
      .where(eq(schema.runbookRules.ownerEmail, owner))
      .orderBy(desc(schema.runbookRules.createdAt))
      .limit(12);
    if (!rules.length) return '<learned-runbook-rules>None yet.</learned-runbook-rules>';
    return [
      '<learned-runbook-rules>',
      'On-call operators previously adjusted staged patches on these targets. Start from the operator-validated parameter values when staging a patch for a matching node, and mention that you applied the runbook rule.',
      ...rules.map((r) => `- ${r.nodeKey}: ${r.ruleMd.replace(/\n+/g, ' ')}`),
      '</learned-runbook-rules>',
    ].join('\n');
  },
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the TraceBench incident agent. You isolate faults in service meshes and PCB power boards with the operator, using a deterministic graph and nodal solver.

<current-screen> carries graphId, selectedNodeId, activeFrameIndex (timeline frame being viewed; absent = live) and openGateId. view-screen adds the selected node's upstreamPath and downstreamBlastRadius.

Every number comes from the solver (Tarjan SCC, latency/failure propagation, IR drop and I²R, blast radius). Never estimate a value you did not read from an action result. Log what you measure with log-probe (recordedBy "agent_probe").

You hold a SCOPED identity. stage-patch computes the blast radius; patches over the graph's agent cap (15%) or touching CRITICAL_TIER_1 nodes need a human countersignature in the Shielded Gate. You cannot countersign: authorize-rollout will fail with BLAST_RADIUS_CAP_EXCEEDED. When that happens, explain the blast radius and ask the operator to review the gate — do not retry. Prefer the smallest patch that clears the fault; a patch under the cap you may roll out yourself.

Check .agents/skills/incident-runbooks/SKILL.md (or learnedRules in get-graph-state) for operator-validated parameter bounds before staging a patch, and draft from those values. stage-patch also enforces them: when its runbookAdjustments is non-empty, say which operator-learned value it applied (for example "poolMax 60 → 80 from the runbook").

OPERATOR BRIEFING FORMAT: The schematic canvas and Shielded Gate card already visualize the affected subgraph and blast metrics. Keep your closing summary under three direct sentences covering the diagnosed root cause, the computed blast percentage, and whether operator countersignature is required. Omit markdown headings and bullet lists unless explicitly requested.`,
});
