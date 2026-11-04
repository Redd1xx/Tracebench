import { createHash } from 'node:crypto';

import { fail } from '@agent-native/core/action';
import { accessFilter } from '@agent-native/core/sharing';
import { and, desc, eq } from 'drizzle-orm';

import { type Diagnosis, diagnose } from '../../app/lib/solver/diagnose';
import type { SolverLink, SolverNode } from '../../app/lib/solver/graph';
import { getDb, schema } from '../db/index.js';
import { SEED_TOPOLOGIES } from '../seed/topologies.js';

export type Ctx = { userEmail?: string | null; orgId?: string | null } | undefined;
export type GraphRow = typeof schema.serviceGraphs.$inferSelect;
export type NodeRow = typeof schema.graphNodes.$inferSelect;
export type LinkRow = typeof schema.graphLinks.$inferSelect;

export type FrameNode = {
  id: string;
  baseLatencyMs: number;
  config: Record<string, unknown>;
  status: SolverNode['status'];
  errorRatePct: number;
  effectiveLatencyMs: number;
  failProbability: number;
  expectedVoltageV: number | null;
  measuredVoltageV: number | null;
  affected: boolean;
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowUs(): number {
  return Date.now() * 1000 + Math.floor((performance.now() % 1) * 1000);
}

export function requireUser(ctx: Ctx): { ownerEmail: string; orgId: string | null } {
  const ownerEmail = ctx?.userEmail ?? fail('Sign in to use TraceBench.', { statusCode: 401, errorCode: 'unauthenticated' });
  return { ownerEmail, orgId: ctx?.orgId ?? null };
}

function parseConfig(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toSolverNode(row: NodeRow): SolverNode {
  return {
    id: row.id,
    key: row.nodeKey,
    label: row.label,
    tier: row.tier,
    baseLatencyMs: row.baseLatencyMs,
    errorRatePct: row.errorRatePct,
    nominalVoltageV: row.nominalVoltageV,
    measuredVoltageV: row.measuredVoltageV,
    trafficSharePct: row.trafficSharePct,
    // FAULT/DEGRADED are derived each solve; only ISOLATED is an input.
    status: row.status === 'ISOLATED' ? 'ISOLATED' : 'HEALTHY',
    config: parseConfig(row.configJson),
  };
}

export function toSolverLink(row: LinkRow): SolverLink {
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    couplingWeight: row.couplingWeight,
    resistanceOhms: row.resistanceOhms,
    status: row.status,
  };
}

export async function loadGraph(id: string): Promise<GraphRow> {
  const { serviceGraphs, serviceGraphShares } = schema;
  const [row] = await getDb()
    .select()
    .from(serviceGraphs)
    .where(and(eq(serviceGraphs.id, id), accessFilter(serviceGraphs, serviceGraphShares)))
    .limit(1);
  if (!row) fail('Graph not found.', { errorCode: 'not_found', statusCode: 404 });
  return row;
}

export async function loadTopology(graph: GraphRow): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const db = getDb();
  const nodes = await db
    .select()
    .from(schema.graphNodes)
    .where(and(eq(schema.graphNodes.graphId, graph.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail)))
    .limit(500);
  const links = await db
    .select()
    .from(schema.graphLinks)
    .where(and(eq(schema.graphLinks.graphId, graph.id), eq(schema.graphLinks.ownerEmail, graph.ownerEmail)))
    .limit(2000);
  return { nodes, links };
}

export function snapshotOf(nodes: SolverNode[], d: Diagnosis): FrameNode[] {
  const affected = new Set(d.affectedNodeIds);
  return nodes.map((n) => {
    const nd = d.nodes.get(n.id)!;
    return {
      id: n.id,
      baseLatencyMs: n.baseLatencyMs,
      config: n.config,
      status: nd.derivedStatus,
      errorRatePct: n.errorRatePct,
      effectiveLatencyMs: nd.effectiveLatencyMs,
      failProbability: nd.failProbability,
      expectedVoltageV: nd.rail?.expectedVoltageV ?? null,
      measuredVoltageV: n.measuredVoltageV,
      affected: affected.has(n.id),
    };
  });
}

// Solve the current topology, persist every derived value on the nodes, and
// append an immutable frame. Returns the diagnosis and the new frame seq.
export async function solveAndRecord(
  graph: GraphRow,
  eventType: string,
  summary: string,
): Promise<{ diagnosis: Diagnosis; frameSeq: number; nodes: SolverNode[] }> {
  const { nodes: nodeRows, links: linkRows } = await loadTopology(graph);
  const nodes = nodeRows.map(toSolverNode);
  const links = linkRows.map(toSolverLink);
  const d = diagnose(graph.domainMode, nodes, links);
  const db = getDb();
  const [last] = await db
    .select({ seq: schema.incidentFrames.frameSeq })
    .from(schema.incidentFrames)
    .where(and(eq(schema.incidentFrames.graphId, graph.id), eq(schema.incidentFrames.ownerEmail, graph.ownerEmail)))
    .orderBy(desc(schema.incidentFrames.frameSeq))
    .limit(1);
  const frameSeq = (last?.seq ?? -1) + 1;
  await db.transaction(async (tx) => {
    for (const n of nodes) {
      const nd = d.nodes.get(n.id)!;
      await tx
        .update(schema.graphNodes)
        .set({
          status: nd.derivedStatus,
          effectiveLatencyMs: nd.effectiveLatencyMs,
          failProbability: nd.failProbability,
          expectedVoltageV: nd.rail?.expectedVoltageV ?? null,
        })
        .where(and(eq(schema.graphNodes.id, n.id), eq(schema.graphNodes.ownerEmail, graph.ownerEmail)));
    }
    await tx.insert(schema.incidentFrames).values({
      id: crypto.randomUUID(),
      graphId: graph.id,
      frameSeq,
      eventType,
      summary,
      snapshotNodesJson: JSON.stringify(snapshotOf(nodes, d)),
      snapshotLinksJson: JSON.stringify(links.map((l) => ({ id: l.id, status: l.status, targetNodeId: l.targetNodeId }))),
      blastRadiusPct: d.blastRadiusPct,
      timestampUs: nowUs(),
      ownerEmail: graph.ownerEmail,
      orgId: graph.orgId,
      visibility: graph.visibility,
    });
    await tx
      .update(schema.serviceGraphs)
      .set({ activeFrameSeq: frameSeq, updatedAt: nowIso() })
      .where(and(eq(schema.serviceGraphs.id, graph.id), eq(schema.serviceGraphs.ownerEmail, graph.ownerEmail)));
  });
  return { diagnosis: d, frameSeq, nodes };
}

const activeBootstrapByOwner = new Map<string, Promise<void>>();

export function ensureWorkspace(ctx: Ctx): Promise<void> {
  const { ownerEmail } = requireUser(ctx);
  const existingTask = activeBootstrapByOwner.get(ownerEmail);
  if (existingTask) return existingTask;
  const bootstrapPromise = bootstrapIncidentGraphs(ctx).finally(() => activeBootstrapByOwner.delete(ownerEmail));
  activeBootstrapByOwner.set(ownerEmail, bootstrapPromise);
  return bootstrapPromise;
}

async function bootstrapIncidentGraphs(ctx: Ctx): Promise<void> {
  const { ownerEmail, orgId } = requireUser(ctx);
  const db = getDb();
  const existing = await db
    .select({ id: schema.serviceGraphs.id })
    .from(schema.serviceGraphs)
    .where(eq(schema.serviceGraphs.ownerEmail, ownerEmail))
    .limit(1);
  if (existing.length) return;
  const visibility = orgId ? ('org' as const) : ('private' as const);
  for (const topo of SEED_TOPOLOGIES) {
    const graphId = crypto.randomUUID();
    const idOf = new Map(topo.nodes.map((n) => [n.key, crypto.randomUUID()]));
    await db.transaction(async (tx) => {
      await tx.insert(schema.serviceGraphs).values({ id: graphId, name: topo.name, domainMode: topo.domainMode, updatedAt: nowIso(), ownerEmail, orgId, visibility });
      await tx.insert(schema.graphNodes).values(
        topo.nodes.map((n) => ({
          id: idOf.get(n.key)!,
          graphId,
          nodeKey: n.key,
          label: n.label,
          tier: n.tier,
          posX: n.x,
          posY: n.y,
          baseLatencyMs: n.baseLatencyMs,
          errorRatePct: n.errorRatePct,
          nominalVoltageV: n.nominalVoltageV,
          measuredVoltageV: n.measuredVoltageV,
          trafficSharePct: n.trafficSharePct,
          status: n.status,
          configJson: JSON.stringify(n.config),
          ownerEmail,
          orgId,
          visibility,
        })),
      );
      await tx.insert(schema.graphLinks).values(
        topo.links.map((l) => ({
          id: crypto.randomUUID(),
          graphId,
          sourceNodeId: idOf.get(l.from)!,
          targetNodeId: idOf.get(l.to)!,
          couplingWeight: l.coupling,
          resistanceOhms: l.ohms,
          ownerEmail,
          orgId,
          visibility,
        })),
      );
    });
    const [graph] = await db.select().from(schema.serviceGraphs).where(and(eq(schema.serviceGraphs.id, graphId), eq(schema.serviceGraphs.ownerEmail, ownerEmail))).limit(1);
    if (graph) await solveAndRecord(graph, 'seed', `Incident opened: ${topo.name}`);
  }
}
