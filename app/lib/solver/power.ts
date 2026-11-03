import { type Adjacency, type SolverLink, type SolverNode, round } from './graph';

// Nodal power solver for a distribution tree. Each node's config declares its
// role: source, buck, ldo, or load. Currents flow up (loads → sources) and
// voltages flow down (sources → loads); a few passes settle the coupling
// between current limits and collapsed outputs.

export type RailState = {
  nodeId: string;
  expectedVoltageV: number;
  inputVoltageV: number | null;
  outputCurrentA: number;
  inputCurrentA: number;
  deviationPct: number | null;
};

export type EdgeState = {
  linkId: string;
  currentA: number;
  dropV: number;
  dissipationW: number;
};

export type PowerSolution = { rails: Map<string, RailState>; edges: Map<string, EdgeState> };

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function solvePower(nodes: SolverNode[], adj: Adjacency, order: string[]): PowerSolution {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const supplyLink = new Map<string, SolverLink | undefined>();
  for (const n of nodes) supplyLink.set(n.id, (adj.out.get(n.id) ?? [])[0]);
  const vOut = new Map<string, number>();
  const vIn = new Map<string, number | null>();
  for (const n of nodes) vOut.set(n.id, n.nominalVoltageV ?? 0);
  const iOut = new Map<string, number>();
  const iIn = new Map<string, number>();

  for (let pass = 0; pass < 6; pass++) {
    // currents, dependents first (reverse of dependency order)
    for (const id of [...order].reverse()) {
      const n = byId.get(id)!;
      if (n.status === 'ISOLATED') {
        iOut.set(id, 0);
        iIn.set(id, 0);
        continue;
      }
      const role = String(n.config.role ?? 'load');
      const children = (adj.inc.get(id) ?? []).reduce((s, l) => s + (iIn.get(l.sourceNodeId) ?? 0), 0);
      const shortOhms = num(n.config, 'shortOhms', 0);
      const out = vOut.get(id)!;
      let load = role === 'load' ? num(n.config, 'loadCurrentA', 0) : children;
      if (shortOhms > 0) load += out / shortOhms;
      iOut.set(id, load);
      const vin = vIn.get(id) ?? null;
      if (role === 'buck' && vin && vin > 0) {
        iIn.set(id, (out * load) / (num(n.config, 'efficiency', 0.9) * vin));
      } else {
        iIn.set(id, load);
      }
    }
    // voltages, supplies first
    for (const id of order) {
      const n = byId.get(id)!;
      const role = String(n.config.role ?? 'load');
      const link = supplyLink.get(id);
      const nominal = n.nominalVoltageV ?? 0;
      if (n.status === 'ISOLATED') {
        vOut.set(id, 0);
        vIn.set(id, null);
        continue;
      }
      if (!link || role === 'source') {
        vIn.set(id, null);
        vOut.set(id, nominal);
        continue;
      }
      const upstream = vOut.get(link.targetNodeId) ?? 0;
      const input = Math.max(0, upstream - (iIn.get(id) ?? 0) * link.resistanceOhms);
      vIn.set(id, input);
      if (role === 'load') {
        vOut.set(id, input);
        continue;
      }
      const dropout = num(n.config, 'dropoutV', role === 'ldo' ? 0.3 : 0.5);
      let out = Math.min(nominal, Math.max(0, input - dropout));
      const limit = num(n.config, 'currentLimitA', Infinity);
      const shortOhms = num(n.config, 'shortOhms', 0);
      if (shortOhms > 0) {
        // load seen at the output: the short in parallel with downstream draw
        const downstream = (adj.inc.get(id) ?? []).reduce((s, l) => s + (iIn.get(l.sourceNodeId) ?? 0), 0);
        const demand = out / shortOhms + downstream;
        if (demand > limit) out = Math.max(0, limit / (1 / shortOhms + (out > 0 ? downstream / out : 0)));
      }
      vOut.set(id, out);
    }
  }

  const rails = new Map<string, RailState>();
  for (const n of nodes) {
    const expected = vOut.get(n.id) ?? 0;
    const measured = n.measuredVoltageV;
    rails.set(n.id, {
      nodeId: n.id,
      expectedVoltageV: round(expected, 3),
      inputVoltageV: vIn.get(n.id) === null || vIn.get(n.id) === undefined ? null : round(vIn.get(n.id)!, 3),
      outputCurrentA: round(iOut.get(n.id) ?? 0, 3),
      inputCurrentA: round(iIn.get(n.id) ?? 0, 3),
      deviationPct:
        n.nominalVoltageV && n.nominalVoltageV > 0
          ? round((((measured ?? expected) - n.nominalVoltageV) / n.nominalVoltageV) * 100, 1)
          : null,
    });
  }
  const edges = new Map<string, EdgeState>();
  for (const n of nodes) {
    const link = supplyLink.get(n.id);
    if (!link) continue;
    const i = iIn.get(n.id) ?? 0;
    edges.set(link.id, {
      linkId: link.id,
      currentA: round(i, 3),
      dropV: round(i * link.resistanceOhms, 4),
      dissipationW: round(i * i * link.resistanceOhms, 4),
    });
  }
  return { rails, edges };
}
