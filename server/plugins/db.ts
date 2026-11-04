import { runMigrations } from '@agent-native/core/db';

const TENANT = `owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'`;

export default runMigrations(
  [
    {
      version: 1,
      name: 'tracebench-core',
      sql: `CREATE TABLE IF NOT EXISTS service_graphs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain_mode TEXT NOT NULL CHECK (domain_mode IN ('distributed_infra', 'hardware_pcb')),
  agent_blast_cap_pct DOUBLE PRECISION NOT NULL DEFAULT 15,
  active_frame_seq INTEGER,
  updated_at TEXT NOT NULL DEFAULT (now()),
  ${TENANT}
);
CREATE TABLE IF NOT EXISTS service_graph_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  notified_at TEXT
);
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES service_graphs(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  label TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('CRITICAL_TIER_1', 'TIER_2', 'EDGE')),
  pos_x DOUBLE PRECISION NOT NULL,
  pos_y DOUBLE PRECISION NOT NULL,
  base_latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  effective_latency_ms DOUBLE PRECISION,
  error_rate_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  fail_probability DOUBLE PRECISION,
  nominal_voltage_v DOUBLE PRECISION,
  measured_voltage_v DOUBLE PRECISION,
  expected_voltage_v DOUBLE PRECISION,
  traffic_share_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'HEALTHY' CHECK (status IN ('HEALTHY', 'DEGRADED', 'FAULT', 'ISOLATED')),
  config_json TEXT NOT NULL DEFAULT '{}',
  ${TENANT}
);
CREATE TABLE IF NOT EXISTS graph_links (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES service_graphs(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  coupling_weight DOUBLE PRECISION NOT NULL,
  resistance_ohms DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CUT')),
  ${TENANT}
);
CREATE TABLE IF NOT EXISTS probe_samples (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES service_graphs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  measured_value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  recorded_by TEXT NOT NULL CHECK (recorded_by IN ('operator', 'agent_probe')),
  created_at TEXT NOT NULL DEFAULT (now()),
  ${TENANT}
);
CREATE TABLE IF NOT EXISTS incident_frames (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES service_graphs(id) ON DELETE CASCADE,
  frame_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  snapshot_nodes_json TEXT NOT NULL,
  snapshot_links_json TEXT NOT NULL DEFAULT '[]',
  blast_radius_pct DOUBLE PRECISION NOT NULL,
  timestamp_us BIGINT NOT NULL,
  ${TENANT},
  UNIQUE (graph_id, frame_seq)
);
CREATE TABLE IF NOT EXISTS rollout_gates (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES service_graphs(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL,
  agent_proposed_patch TEXT NOT NULL,
  operator_final_patch TEXT,
  patch_diff_hash TEXT NOT NULL,
  computed_blast_radius_pct DOUBLE PRECISION NOT NULL,
  affected_node_ids_json TEXT NOT NULL DEFAULT '[]',
  requires_human_shield BOOLEAN NOT NULL,
  staged_by TEXT NOT NULL CHECK (staged_by IN ('agent', 'operator')),
  status TEXT NOT NULL DEFAULT 'SHIELDED_PENDING' CHECK (status IN ('SHIELDED_PENDING', 'APPROVED_APPLIED', 'REJECTED')),
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  ${TENANT}
);
CREATE INDEX IF NOT EXISTS service_graphs_owner_idx ON service_graphs (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS service_graph_shares_resource_idx ON service_graph_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS graph_nodes_graph_idx ON graph_nodes (graph_id);
CREATE INDEX IF NOT EXISTS graph_links_graph_idx ON graph_links (graph_id);
CREATE INDEX IF NOT EXISTS probe_samples_graph_idx ON probe_samples (graph_id, created_at);
CREATE INDEX IF NOT EXISTS incident_frames_graph_idx ON incident_frames (graph_id, frame_seq);
CREATE INDEX IF NOT EXISTS rollout_gates_graph_idx ON rollout_gates (graph_id, created_at)`,
    },
    {
      version: 2,
      name: 'runbook-rules',
      sql: `CREATE TABLE IF NOT EXISTS runbook_rules (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  rule_md TEXT NOT NULL,
  unified_diff TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  ${TENANT}
);
CREATE INDEX IF NOT EXISTS runbook_rules_owner_idx ON runbook_rules (owner_email, created_at)`,
    },
  ],
  { table: 'tracebench_migrations' },
);
