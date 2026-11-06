import { adjacency, tarjanScc, type SolverLink, type SolverNode } from '@/lib/solver/graph';

// Layered top-down layout. Dependents sit above what they depend on, so a
// fault flows visibly upward to everything it hurts; power boards flip so the
// source rail is on top. Cycles (SCCs) share a layer. Within a layer, nodes
// are ordered by the mean position of their parents (one barycenter sweep).

export type Placed = { x: number; y: number };

export const NODE_W = 236;
export const NODE_H = 76;
const GAP_X = 56;
const GAP_Y = 38;

export function layeredLayout(nodes: SolverNode[], links: SolverLink[], sourceOnTop: boolean): Map<string, Placed> {
  const adj = adjacency(nodes, links.map((l) => ({ ...l, status: 'ACTIVE' as const })));
  const sccs = tarjanScc(nodes, adj);
  const compOf = new Map<string, number>();
  sccs.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));

  // Tarjan emits dependencies first, so walking components in reverse
  // visits dependents before dependencies: longest-path layering from callers.
  const layerOfComp = new Map<number, number>();
  for (let i = sccs.length - 1; i >= 0; i--) {
    const layer = layerOfComp.get(i) ?? 0;
    layerOfComp.set(i, layer);
    for (const id of sccs[i]!) {
      for (const l of adj.out.get(id) ?? []) {
        const target = compOf.get(l.targetNodeId)!;
        if (target !== i) layerOfComp.set(target, Math.max(layerOfComp.get(target) ?? 0, layer + 1));
      }
    }
  }
  const maxLayer = Math.max(0, ...layerOfComp.values());
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) {
    const raw = layerOfComp.get(compOf.get(n.id)!) ?? 0;
    layers[sourceOnTop ? maxLayer - raw : raw]!.push(n.id);
  }

  const orderIndex = new Map<string, number>();
  layers.forEach((layer, li) => {
    if (li > 0) {
      const prev = layers[li - 1]!;
      const score = (id: string): number => {
        const neighbours = [...(adj.inc.get(id) ?? []).map((l) => l.sourceNodeId), ...(adj.out.get(id) ?? []).map((l) => l.targetNodeId)]
          .filter((nid) => prev.includes(nid))
          .map((nid) => orderIndex.get(nid) ?? 0);
        return neighbours.length ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length : Number.MAX_SAFE_INTEGER;
      };
      layer.sort((a, b) => score(a) - score(b));
    }
    layer.forEach((id, i) => orderIndex.set(id, i));
  });

  const widest = Math.max(...layers.map((l) => l.length));
  const span = widest * NODE_W + (widest - 1) * GAP_X;
  const placed = new Map<string, Placed>();
  layers.forEach((layer, li) => {
    const rowWidth = layer.length * NODE_W + (layer.length - 1) * GAP_X;
    const start = (span - rowWidth) / 2;
    layer.forEach((id, i) => placed.set(id, { x: 40 + start + i * (NODE_W + GAP_X), y: 40 + li * (NODE_H + GAP_Y) }));
  });
  return placed;
}
