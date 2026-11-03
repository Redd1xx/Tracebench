import { z } from 'zod';

import { type DomainMode, PROPAGATION_THRESHOLD, blastPct } from './diagnose';
import { type SolverLink, type SolverNode, adjacency, dependents } from './graph';

// A remediation patch is a small JSON document the agent drafts and the
// operator may hand-edit before rollout. Its SHA-256 is the approval handle.

export const patchSchema = z.object({
  kind: z.enum(['config', 'isolate', 'restart', 'reroute']),
  target: z.string().min(1),
  set: z
    .object({
      baseLatencyMs: z.number().min(0).optional(),
      errorRatePct: z.number().min(0).max(100).optional(),
      trafficSharePct: z.number().min(0).max(100).optional(),
      config: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),
    })
    .optional(),
  fallback: z.string().optional(),
  note: z.string().max(500).optional(),
});
export type Patch = z.infer<typeof patchSchema>;

export type ParsedPatch = { ok: true; patch: Patch } | { ok: false; error: string };

export function parsePatch(text: string): ParsedPatch {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Patch is not valid JSON.' };
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, patch: parsed.data };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Key order and whitespace never change the hash; any value change does.
export function canonicalPatch(text: string): string {
  const parsed = parsePatch(text);
  return parsed.ok ? stableStringify(parsed.patch) : text.trim();
}

export type PatchImpact = { targetNodeId: string; affectedNodeIds: string[]; blastRadiusPct: number };

// isolate/restart take the target fully offline, so every dependent is hit;
// config/reroute only reach dependents coupled at ≥ PROPAGATION_THRESHOLD.
export function patchImpact(patch: Patch, nodes: SolverNode[], links: SolverLink[]): PatchImpact | null {
  const target = nodes.find((n) => n.key === patch.target || n.id === patch.target);
  if (!target) return null;
  const adj = adjacency(nodes, links);
  const threshold = patch.kind === 'isolate' || patch.kind === 'restart' ? 0 : PROPAGATION_THRESHOLD;
  const affected = [...dependents(adj, target.id, threshold).keys()];
  return { targetNodeId: target.id, affectedNodeIds: affected, blastRadiusPct: blastPct(nodes, affected) };
}

export function applyPatch(
  patch: Patch,
  nodes: SolverNode[],
  links: SolverLink[],
  mode: DomainMode,
): { nodes: SolverNode[]; links: SolverLink[]; summary: string } {
  const target = nodes.find((n) => n.key === patch.target || n.id === patch.target);
  if (!target) return { nodes, links, summary: 'target missing' };
  const fallback = patch.fallback ? nodes.find((n) => n.key === patch.fallback || n.id === patch.fallback) : undefined;
  let nextLinks = links.map((l) => ({ ...l }));
  const nextNodes = nodes.map((n) => {
    if (n.id !== target.id) return { ...n };
    const copy: SolverNode = { ...n, config: { ...n.config } };
    if (patch.kind === 'config' && patch.set) {
      if (patch.set.baseLatencyMs !== undefined) copy.baseLatencyMs = patch.set.baseLatencyMs;
      if (patch.set.errorRatePct !== undefined) copy.errorRatePct = patch.set.errorRatePct;
      if (patch.set.trafficSharePct !== undefined) copy.trafficSharePct = patch.set.trafficSharePct;
      for (const [k, v] of Object.entries(patch.set.config ?? {})) {
        if (v === null) delete copy.config[k];
        else copy.config[k] = v;
      }
      if (copy.status === 'FAULT') copy.status = 'DEGRADED';
      // A pool node's errors come from exhaustion: once a config change leaves headroom (in use < max) and the
      // patch does not pin an error rate itself, requests stop failing on checkout and errors fall to baseline.
      const { poolMax, poolInUse } = copy.config;
      const touchesPool = patch.set.config && ('poolMax' in patch.set.config || 'poolInUse' in patch.set.config);
      if (touchesPool && patch.set.errorRatePct === undefined && typeof poolMax === 'number' && typeof poolInUse === 'number' && poolInUse < poolMax) {
        const baseline = typeof copy.config.baselineErrorRatePct === 'number' ? copy.config.baselineErrorRatePct : 0.1;
        copy.errorRatePct = Math.min(copy.errorRatePct, baseline);
        copy.status = 'HEALTHY';
      }
    }
    if (patch.kind === 'restart') {
      const baseline = typeof copy.config.baselineErrorRatePct === 'number' ? copy.config.baselineErrorRatePct : 0.1;
      copy.errorRatePct = baseline;
      copy.status = 'HEALTHY';
      if (mode === 'hardware_pcb') delete copy.config.shortOhms;
    }
    if (patch.kind === 'isolate') copy.status = 'ISOLATED';
    return copy;
  });
  if (patch.kind === 'isolate' || patch.kind === 'reroute') {
    nextLinks = nextLinks.map((l) => {
      if (l.targetNodeId !== target.id) return l;
      if (fallback && fallback.id !== l.sourceNodeId) return { ...l, targetNodeId: fallback.id };
      return patch.kind === 'isolate' ? { ...l, status: 'CUT' as const } : l;
    });
  }
  const summary =
    patch.kind === 'config'
      ? `config ${target.key}: ${JSON.stringify(patch.set ?? {})}`
      : patch.kind === 'isolate'
        ? `isolate ${target.key}${fallback ? ` → fallback ${fallback.key}` : ''}`
        : patch.kind === 'reroute'
          ? `reroute ${target.key} traffic → ${fallback?.key ?? 'none'}`
          : `restart ${target.key}`;
  return { nodes: nextNodes, links: nextLinks, summary };
}
