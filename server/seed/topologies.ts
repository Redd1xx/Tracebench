import type { DomainMode } from '../../app/lib/solver/diagnose';
import type { NodeStatus, Tier } from '../../app/lib/solver/graph';

// Starter incidents. Edges are "depends on". Faults are physical inputs
// (an exhausted pool's error rate, a shorted rail's resistance); every derived
// number — effective latency, failure odds, voltages, blast radius — comes
// from the solver.

type NodeSeed = {
  key: string;
  label: string;
  tier: Tier;
  x: number;
  y: number;
  baseLatencyMs: number;
  errorRatePct: number;
  nominalVoltageV: number | null;
  measuredVoltageV: number | null;
  trafficSharePct: number;
  status: NodeStatus;
  config: Record<string, unknown>;
};
type LinkSeed = { from: string; to: string; coupling: number; ohms: number };
export type TopologySeed = { name: string; domainMode: DomainMode; nodes: NodeSeed[]; links: LinkSeed[] };

function svc(key: string, label: string, tier: Tier, x: number, y: number, latency: number, err: number, share: number, extra: Record<string, unknown> = {}): NodeSeed {
  return { key, label, tier, x, y, baseLatencyMs: latency, errorRatePct: err, nominalVoltageV: null, measuredVoltageV: null, trafficSharePct: share, status: 'HEALTHY', config: { baselineErrorRatePct: 0.1, ...extra } };
}

function rail(key: string, label: string, tier: Tier, x: number, y: number, nominal: number, measured: number | null, share: number, config: Record<string, unknown>): NodeSeed {
  return { key, label, tier, x, y, baseLatencyMs: 0, errorRatePct: 0, nominalVoltageV: nominal, measuredVoltageV: measured, trafficSharePct: share, status: 'HEALTHY', config };
}

export const SEED_TOPOLOGIES: TopologySeed[] = [
  {
    name: 'Global Payment Checkout Mesh',
    domainMode: 'distributed_infra',
    nodes: [
      svc('edge-cdn', 'Edge CDN', 'EDGE', 80, 260, 12, 0.05, 18),
      svc('api-gateway', 'API Gateway', 'CRITICAL_TIER_1', 260, 260, 8, 0.1, 16),
      svc('checkout-svc', 'Checkout', 'CRITICAL_TIER_1', 440, 180, 35, 0.2, 14),
      svc('cart-svc', 'Cart', 'TIER_2', 440, 360, 22, 0.1, 10),
      svc('pricing-svc', 'Pricing', 'TIER_2', 640, 420, 18, 0.1, 7),
      svc('payment-orchestrator', 'Payment Orchestrator', 'CRITICAL_TIER_1', 640, 140, 40, 0.3, 12),
      svc('fraud-scorer', 'Fraud Scorer', 'TIER_2', 840, 60, 55, 0.4, 6),
      svc('ledger-writer', 'Ledger Writer', 'TIER_2', 840, 260, 25, 0.2, 6),
      svc('payments-db', 'Payments DB (pool)', 'CRITICAL_TIER_1', 1040, 160, 900, 38, 8, { poolMax: 40, poolInUse: 40, timeoutMs: 3000 }),
      svc('kafka-events', 'Kafka Events', 'TIER_2', 1040, 360, 6, 0.05, 3, { consumerLag: 18000 }),
    ],
    links: [
      { from: 'edge-cdn', to: 'api-gateway', coupling: 1, ohms: 0 },
      { from: 'api-gateway', to: 'checkout-svc', coupling: 0.8, ohms: 0 },
      { from: 'api-gateway', to: 'cart-svc', coupling: 0.6, ohms: 0 },
      { from: 'checkout-svc', to: 'cart-svc', coupling: 0.5, ohms: 0 },
      { from: 'checkout-svc', to: 'pricing-svc', coupling: 0.4, ohms: 0 },
      { from: 'checkout-svc', to: 'payment-orchestrator', coupling: 0.9, ohms: 0 },
      { from: 'cart-svc', to: 'pricing-svc', coupling: 0.3, ohms: 0 },
      { from: 'payment-orchestrator', to: 'fraud-scorer', coupling: 0.7, ohms: 0 },
      { from: 'payment-orchestrator', to: 'payments-db', coupling: 0.9, ohms: 0 },
      { from: 'payment-orchestrator', to: 'ledger-writer', coupling: 0.5, ohms: 0 },
      { from: 'ledger-writer', to: 'payments-db', coupling: 0.8, ohms: 0 },
      { from: 'ledger-writer', to: 'kafka-events', coupling: 0.4, ohms: 0 },
      { from: 'fraud-scorer', to: 'kafka-events', coupling: 0.2, ohms: 0 },
      { from: 'kafka-events', to: 'ledger-writer', coupling: 0.1, ohms: 0 },
    ],
  },
  {
    name: 'Embedded Power Distribution Board',
    domainMode: 'hardware_pcb',
    nodes: [
      rail('vin-12v', 'VIN 12V', 'CRITICAL_TIER_1', 80, 240, 12, null, 10, { role: 'source' }),
      rail('buck-5v', 'BUCK 5V0', 'CRITICAL_TIER_1', 300, 240, 5, null, 20, { role: 'buck', efficiency: 0.92, dropoutV: 0.5, currentLimitA: 6 }),
      rail('buck-3v3', 'BUCK 3V3', 'TIER_2', 520, 120, 3.3, 0.46, 15, { role: 'buck', efficiency: 0.9, dropoutV: 0.5, currentLimitA: 3, shortOhms: 0.15 }),
      rail('ldo-1v8', 'LDO 1V8 IO', 'TIER_2', 760, 60, 1.8, null, 8, { role: 'ldo', dropoutV: 0.3 }),
      rail('ldo-1v2', 'LDO 1V2 CORE', 'CRITICAL_TIER_1', 520, 360, 1.2, null, 10, { role: 'ldo', dropoutV: 0.3 }),
      rail('mcu-core', 'MCU core', 'CRITICAL_TIER_1', 760, 360, 1.2, null, 17, { role: 'load', loadCurrentA: 0.45 }),
      rail('sensor-afe', 'Sensor AFE', 'TIER_2', 760, 180, 3.3, null, 8, { role: 'load', loadCurrentA: 0.12 }),
      rail('radio-pa', 'Radio PA', 'EDGE', 520, 460, 5, null, 12, { role: 'load', loadCurrentA: 0.8 }),
    ],
    links: [
      { from: 'buck-5v', to: 'vin-12v', coupling: 1, ohms: 0.02 },
      { from: 'buck-3v3', to: 'buck-5v', coupling: 1, ohms: 0.03 },
      { from: 'ldo-1v8', to: 'buck-3v3', coupling: 1, ohms: 0.05 },
      { from: 'ldo-1v2', to: 'buck-5v', coupling: 1, ohms: 0.04 },
      { from: 'mcu-core', to: 'ldo-1v2', coupling: 1, ohms: 0.01 },
      { from: 'sensor-afe', to: 'buck-3v3', coupling: 1, ohms: 0.08 },
      { from: 'radio-pa', to: 'buck-5v', coupling: 1, ohms: 0.05 },
    ],
  },
];
