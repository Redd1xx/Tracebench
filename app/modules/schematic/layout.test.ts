import { describe, expect, it } from 'vitest';

import type { SolverLink, SolverNode } from '@/lib/solver/graph';

import { layeredLayout, NODE_H } from './layout';

function node(id: string): SolverNode {
  return { id, key: id, label: id, tier: 'TIER_2', baseLatencyMs: 0, errorRatePct: 0, nominalVoltageV: null, measuredVoltageV: null, trafficSharePct: 0, status: 'HEALTHY', config: {} };
}

function link(from: string, to: string): SolverLink {
  return { id: `${from}-${to}`, sourceNodeId: from, targetNodeId: to, couplingWeight: 1, resistanceOhms: 0, status: 'ACTIVE' };
}

describe('layered layout', () => {
  const nodes = ['gw', 'svc', 'db', 'a', 'b'].map(node);
  const links = [link('gw', 'svc'), link('svc', 'db'), link('svc', 'a'), link('a', 'b'), link('b', 'a')];

  it('places dependents above what they depend on', () => {
    const pos = layeredLayout(nodes, links, false);
    expect(pos.get('gw')!.y).toBeLessThan(pos.get('svc')!.y);
    expect(pos.get('svc')!.y).toBeLessThan(pos.get('db')!.y);
  });

  it('keeps a cycle on one row', () => {
    const pos = layeredLayout(nodes, links, false);
    expect(pos.get('a')!.y).toBe(pos.get('b')!.y);
  });

  it('flips for power trees so the source rail is on top', () => {
    const pos = layeredLayout(nodes, links, true);
    expect(pos.get('db')!.y).toBeLessThan(pos.get('gw')!.y);
  });

  it('never overlaps two nodes', () => {
    const pos = [...layeredLayout(nodes, links, false).values()];
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const sameRow = Math.abs(pos[i]!.y - pos[j]!.y) < NODE_H;
        if (sameRow) expect(Math.abs(pos[i]!.x - pos[j]!.x)).toBeGreaterThan(100);
      }
    }
  });
});
