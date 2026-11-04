import { createSharesTable, ownableColumns } from '@agent-native/core/db/schema';
import { sql } from 'drizzle-orm';
import { bigint, boolean, doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';

// A service graph is the shareable resource. Its nodes, links, probes, frames
// and gates copy the graph's owner/org so every child row stays tenant-scoped.

export const serviceGraphs = pgTable('service_graphs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domainMode: text('domain_mode', { enum: ['distributed_infra', 'hardware_pcb'] }).notNull(),
  agentBlastCapPct: doublePrecision('agent_blast_cap_pct').notNull().default(15),
  activeFrameSeq: integer('active_frame_seq'),
  updatedAt: text('updated_at').notNull().default(sql`now()`),
  ...ownableColumns(),
});
export const serviceGraphShares = createSharesTable('service_graph_shares');

export const graphNodes = pgTable('graph_nodes', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  nodeKey: text('node_key').notNull(),
  label: text('label').notNull(),
  tier: text('tier', { enum: ['CRITICAL_TIER_1', 'TIER_2', 'EDGE'] }).notNull(),
  posX: doublePrecision('pos_x').notNull(),
  posY: doublePrecision('pos_y').notNull(),
  baseLatencyMs: doublePrecision('base_latency_ms').notNull().default(0),
  effectiveLatencyMs: doublePrecision('effective_latency_ms'),
  errorRatePct: doublePrecision('error_rate_pct').notNull().default(0),
  failProbability: doublePrecision('fail_probability'),
  nominalVoltageV: doublePrecision('nominal_voltage_v'),
  measuredVoltageV: doublePrecision('measured_voltage_v'),
  expectedVoltageV: doublePrecision('expected_voltage_v'),
  trafficSharePct: doublePrecision('traffic_share_pct').notNull().default(0),
  status: text('status', { enum: ['HEALTHY', 'DEGRADED', 'FAULT', 'ISOLATED'] }).notNull().default('HEALTHY'),
  configJson: text('config_json').notNull().default('{}'),
  ...ownableColumns(),
});

export const graphLinks = pgTable('graph_links', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  sourceNodeId: text('source_node_id').notNull(),
  targetNodeId: text('target_node_id').notNull(),
  couplingWeight: doublePrecision('coupling_weight').notNull(),
  resistanceOhms: doublePrecision('resistance_ohms').notNull().default(0),
  status: text('status', { enum: ['ACTIVE', 'CUT'] }).notNull().default('ACTIVE'),
  ...ownableColumns(),
});

export const probeSamples = pgTable('probe_samples', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  nodeId: text('node_id').notNull(),
  metricName: text('metric_name').notNull(),
  measuredValue: doublePrecision('measured_value').notNull(),
  unit: text('unit').notNull(),
  recordedBy: text('recorded_by', { enum: ['operator', 'agent_probe'] }).notNull(),
  createdAt: text('created_at').notNull().default(sql`now()`),
  ...ownableColumns(),
});

export const incidentFrames = pgTable('incident_frames', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  frameSeq: integer('frame_seq').notNull(),
  eventType: text('event_type').notNull(),
  summary: text('summary').notNull(),
  snapshotNodesJson: text('snapshot_nodes_json').notNull(),
  snapshotLinksJson: text('snapshot_links_json').notNull().default('[]'),
  blastRadiusPct: doublePrecision('blast_radius_pct').notNull(),
  timestampUs: bigint('timestamp_us', { mode: 'number' }).notNull(),
  ...ownableColumns(),
});

export const rolloutGates = pgTable('rollout_gates', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  targetNodeId: text('target_node_id').notNull(),
  agentProposedPatch: text('agent_proposed_patch').notNull(),
  operatorFinalPatch: text('operator_final_patch'),
  patchDiffHash: text('patch_diff_hash').notNull(),
  computedBlastRadiusPct: doublePrecision('computed_blast_radius_pct').notNull(),
  affectedNodeIdsJson: text('affected_node_ids_json').notNull().default('[]'),
  requiresHumanShield: boolean('requires_human_shield').notNull(),
  stagedBy: text('staged_by', { enum: ['agent', 'operator'] }).notNull(),
  status: text('status', { enum: ['SHIELDED_PENDING', 'APPROVED_APPLIED', 'REJECTED'] }).notNull().default('SHIELDED_PENDING'),
  approvedBy: text('approved_by'),
  createdAt: text('created_at').notNull().default(sql`now()`),
  ...ownableColumns(),
});

// Remediation rules learned from operator hand edits. SQL is the durable copy; the skill file mirrors it when writable.
export const runbookRules = pgTable('runbook_rules', {
  id: text('id').primaryKey(),
  graphId: text('graph_id').notNull(),
  gateId: text('gate_id').notNull(),
  nodeKey: text('node_key').notNull(),
  ruleMd: text('rule_md').notNull(),
  unifiedDiff: text('unified_diff').notNull(),
  createdAt: text('created_at').notNull().default(sql`now()`),
  ...ownableColumns(),
});
