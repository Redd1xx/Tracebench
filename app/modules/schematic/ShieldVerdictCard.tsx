import { registerActionChatRenderer, type ToolRendererProps } from '@agent-native/toolkit/app/chat';
import { IconArrowUpRight, IconLock, IconShieldCheck } from '@tabler/icons-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';

const mountedVerdictNodes = new Map<string, object>();

type ShieldVerdict = {
  id: string;
  graphId: string;
  graphName: string;
  targetKey: string;
  targetLabel: string;
  targetTier: string;
  stagedBy: string;
  computedBlastRadiusPct: number;
  agentBlastCapPct: number;
  requiresHumanShield: boolean;
  shieldReasons: string[];
  patchDiffHash: string;
  affectedKeys: string[];
};

function isShieldVerdict(value: unknown): value is ShieldVerdict {
  return !!value && typeof value === 'object' && 'computedBlastRadiusPct' in value && 'patchDiffHash' in value && 'graphId' in value;
}

// Blast radius on a 0–100 scale with the agent cap as a tick, read like a scope trace against its trigger level.
function BlastMeter({ pct, cap }: { pct: number; cap: number }): React.ReactElement {
  const over = pct > cap;
  return (
    <div className="relative h-3 w-full bg-[hsl(var(--tb-ink)/0.08)]" role="img" aria-label={`Blast radius ${pct}% against a ${cap}% agent cap`}>
      <div
        className={over ? 'absolute inset-y-0 left-0 bg-[hsl(var(--tb-fault))]' : 'absolute inset-y-0 left-0 bg-[hsl(var(--tb-trace))]'}
        style={{ width: `${Math.min(100, Math.max(1, pct))}%` }}
      />
      <div className="absolute -inset-y-1 w-px bg-[hsl(var(--tb-amber))]" style={{ left: `${cap}%` }} />
      <span className="tb-readout absolute -top-4 text-[11px] text-[hsl(var(--tb-amber))]" style={{ left: `calc(${cap}% + 3px)` }}>
        cap {cap}%
      </span>
    </div>
  );
}

export function ShieldVerdictCard({ context }: ToolRendererProps): React.ReactElement | null {
  const refObj = useRef<object>({});
  const [suppressed, setSuppressed] = useState(false);
  useLayoutEffect(() => {
    const key = context.widgetId;
    if (!key) return;
    const existing = mountedVerdictNodes.get(key);
    if (existing && existing !== refObj.current) {
      setSuppressed(true);
      return;
    }
    mountedVerdictNodes.set(key, refObj.current);
    return () => {
      if (mountedVerdictNodes.get(key) === refObj.current) mountedVerdictNodes.delete(key);
    };
  }, [context.widgetId]);
  if (suppressed) return null;
  if (context.isRunning) {
    return (
      <div className="my-2 w-full max-w-md rounded-xl border border-border bg-[hsl(var(--tb-ground))] p-3" aria-busy="true">
        <Skeleton className="h-3 w-40 rounded-md" />
        <Skeleton className="mt-4 h-3 w-full rounded-md" />
        <Skeleton className="mt-3 h-8 w-full rounded-md" />
      </div>
    );
  }
  const v = context.resultJson;
  if (!isShieldVerdict(v)) return null;
  const shielded = v.requiresHumanShield;
  const gateLink = `/bench/${encodeURIComponent(v.graphId)}?gate=${encodeURIComponent(v.id)}`;

  return (
    <article
      className={`my-2 w-full max-w-md rounded-xl border bg-[hsl(var(--tb-ground))] text-[hsl(var(--tb-ink))] ${
        shielded ? 'border-[hsl(var(--tb-amber)/0.7)]' : 'border-[hsl(var(--tb-trace)/0.6)]'
      }`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--tb-ink)/0.12)] px-3 py-1.5">
        <span className={`tb-readout shrink-0 whitespace-nowrap text-[11px] ${shielded ? 'text-[hsl(var(--tb-amber))]' : 'text-[hsl(var(--tb-trace))]'}`}>
          {shielded ? 'Gate pending' : 'Within agent cap'}
        </span>
        <span className="tb-readout truncate text-[11px] text-muted-foreground">{v.graphName}</span>
      </header>

      <div className="flex items-end justify-between gap-3 px-3 pt-2.5">
        <div className="min-w-0">
          <h3 className="tb-head truncate text-base font-bold">{v.targetLabel}</h3>
          <p className="tb-readout text-[11px] text-muted-foreground">
            {v.targetKey} · {v.targetTier} · staged by {v.stagedBy}
          </p>
        </div>
        <p className={`tb-dot shrink-0 whitespace-nowrap text-4xl ${shielded ? 'text-[hsl(var(--tb-fault))]' : 'text-[hsl(var(--tb-trace))]'}`}>
          {v.computedBlastRadiusPct}%
        </p>
      </div>

      <div className="px-3 pb-1 pt-6">
        <BlastMeter pct={v.computedBlastRadiusPct} cap={v.agentBlastCapPct} />
      </div>

      {shielded ? (
        <div className="mx-3 mt-2.5 flex gap-2 border-l-2 border-[hsl(var(--tb-amber))] bg-[hsl(var(--tb-amber)/0.08)] px-2 py-1.5">
          <IconLock className="mt-0.5 size-3.5 shrink-0 text-[hsl(var(--tb-amber))]" aria-hidden="true" />
          <div className="text-[11px] leading-snug">
            <p>The agent cannot roll this out. Only the operator can countersign this exact hash.</p>
            <ul className="tb-readout mt-1 text-[11px] text-muted-foreground">
              {v.shieldReasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="mx-3 mt-2.5 flex items-center gap-1.5 text-[11px]">
          <IconShieldCheck className="size-3.5 text-[hsl(var(--tb-trace))]" aria-hidden="true" />
          Under the {v.agentBlastCapPct}% cap on a non-critical node: the agent may roll it out.
        </p>
      )}

      <p className="tb-readout px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        HITS {v.affectedKeys.join(' · ') || '—'}
      </p>

      <footer className="mt-2 flex items-center justify-between gap-2 border-t border-[hsl(var(--tb-ink)/0.12)] px-3 py-2">
        <span className="tb-readout truncate text-[11px] text-muted-foreground">sha256 {v.patchDiffHash.slice(0, 16)}…</span>
        <Link
          to={gateLink}
          className="tb-readout inline-flex shrink-0 items-center gap-1 rounded-xl bg-[hsl(var(--tb-trace))] px-2 py-1 text-[11px] text-[hsl(var(--tb-ground))] hover:opacity-90"
        >
          {shielded ? 'Open the gate' : 'View patch'} <IconArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      </footer>
    </article>
  );
}

registerActionChatRenderer({
  id: 'tracebench.shield-verdict',
  renderer: 'tracebench.shield-verdict',
  Component: ShieldVerdictCard,
});
