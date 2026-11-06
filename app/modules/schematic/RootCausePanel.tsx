import { IconCrosshair, IconMessageForward } from '@tabler/icons-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { adjacency, dependencies, dependents } from '@/lib/solver/graph';

type GraphState = AgentNativeActionRegistry['get-graph-state']['result'];

type Suspect = { id: string; key: string; label: string; score: number; evidence: string[] };

type Props = {
  data: GraphState;
  onInvestigate: (nodeId: string) => void;
  onAsk: (nodeId: string) => void;
};

// Ranked suspects with the evidence behind each rank, read from the solver output already on screen: the operator
// sees why a node is first before deciding where to probe or what to hand the agent.
export function RootCausePanel({ data, onInvestigate, onAsk }: Props): React.ReactElement | null {
  const suspects = useMemo<Suspect[]>(() => {
    const keyOf = (id: string): string => data.nodes.find((n) => n.id === id)?.key ?? id;
    const adj = adjacency(data.nodes, data.links);
    return data.nodes
      .filter((n) => n.rootCauseScore > 0 || n.status === 'FAULT')
      .sort((a, b) => b.rootCauseScore - a.rootCauseScore)
      .slice(0, 3)
      .map((n) => {
        const evidence: string[] = [];
        if (n.measuredVoltageV !== null && n.expectedVoltageV !== null) {
          evidence.push(`Rail reads ${n.measuredVoltageV.toFixed(3)} V against ${n.expectedVoltageV.toFixed(3)} V expected.`);
        } else {
          evidence.push(`${n.status.charAt(0)}${n.status.slice(1).toLowerCase()} · error ${n.errorRatePct}% · failure probability ${(n.failProbability * 100).toFixed(0)}%.`);
          if (n.effectiveLatencyMs > n.baseLatencyMs * 1.5) evidence.push(`Latency ${n.effectiveLatencyMs} ms against a ${n.baseLatencyMs} ms base.`);
        }
        const failingUpstream = [...dependencies(adj, n.id)].filter((id) => id !== n.id && data.nodes.find((x) => x.id === id)?.status === 'FAULT');
        evidence.push(failingUpstream.length ? `Depends on failing ${failingUpstream.map(keyOf).join(', ')}.` : 'Nothing it depends on is failing, so the fault starts here.');
        const hit = [...dependents(adj, n.id).keys()].filter((id) => id !== n.id);
        if (hit.length) evidence.push(`${hit.length} dependent${hit.length > 1 ? 's' : ''} downstream: ${hit.slice(0, 3).map(keyOf).join(', ')}${hit.length > 3 ? '…' : ''}.`);
        const probe = data.probes.find((p) => p.nodeId === n.id);
        if (probe) evidence.push(`${probe.recordedBy === 'operator' ? 'Operator' : 'Agent'} probe: ${probe.metricName} ${probe.measuredValue}${probe.unit}.`);
        return { id: n.id, key: n.key, label: n.label, score: n.rootCauseScore, evidence };
      });
  }, [data]);

  if (!suspects.length) return null;
  return (
    <section className="space-y-2" aria-label="Likely root cause">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold"><IconCrosshair className="size-4 text-[hsl(var(--tb-fault))]" /> Likely root cause</h2>
      <ol className="space-y-2">
        {suspects.map((s, i) => (
          <li key={s.id} className={i === 0 ? 'rounded-xl border border-[hsl(var(--tb-fault)/0.5)] bg-[hsl(var(--tb-fault)/0.06)] p-3' : 'rounded-xl border border-border p-3'}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="tb-head truncate text-sm font-bold">{s.label}</span>
              <span className="tb-readout shrink-0 text-[11px] text-muted-foreground">
                {s.key} · score {s.score.toFixed(2)}
              </span>
            </div>
            <ul className="mt-1.5 space-y-0.5 text-xs leading-snug text-muted-foreground">
              {s.evidence.map((e) => (
                <li key={e} className="flex gap-1.5">
                  <span aria-hidden="true" className="text-[hsl(var(--tb-fault))]">·</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" onClick={() => onInvestigate(s.id)}>
                <IconCrosshair className="size-3.5" /> Investigate
              </Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" onClick={() => onAsk(s.id)}>
                <IconMessageForward className="size-3.5" /> Ask agent
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
