import { IconBook, IconShieldCheck, IconShieldLock, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type Gate = AgentNativeActionRegistry['get-graph-state']['result']['gates'][number];
type GraphNode = AgentNativeActionRegistry['get-graph-state']['result']['nodes'][number];

type DiffRow = { path: string[]; label: string; before: unknown; after: unknown };

const TOP_FIELDS = ['errorRatePct', 'baseLatencyMs', 'trafficSharePct'] as const;

// The fields a config patch changes, read against the target node as it stands now. null = draft is not valid JSON.
function diffRows(draft: string, node: GraphNode | undefined): DiffRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch {
    return null;
  }
  const set = (parsed as { set?: Record<string, unknown> } | null)?.set;
  if (!set || typeof set !== 'object') return [];
  const rows: DiffRow[] = [];
  for (const k of TOP_FIELDS) if (k in set) rows.push({ path: ['set', k], label: k, before: node?.[k], after: set[k] });
  const config = set.config && typeof set.config === 'object' ? (set.config as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(config)) rows.push({ path: ['set', 'config', k], label: k, before: node?.config[k], after: v });
  return rows;
}

function writePath(draft: string, path: string[], value: number): string {
  const root = JSON.parse(draft) as Record<string, unknown>;
  let obj: Record<string, unknown> = root;
  for (const k of path.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
  const last = path[path.length - 1];
  if (last !== undefined) obj[last] = value;
  return JSON.stringify(root, null, 2);
}

const fmt = (v: unknown): string => (v === undefined || v === null ? '—' : typeof v === 'number' ? String(v) : JSON.stringify(v));

type Props = {
  gate: Gate;
  /** The target node as it stands now; gives the "before" side of the field diff. */
  target?: GraphNode | undefined;
  open: boolean;
  capPct: number;
  keyOf: (id: string) => string;
  busy: boolean;
  onOpen: () => void;
  onCountersign: (gate: Gate, operatorPatch: string | null) => void;
  onReject: (gate: Gate) => void;
  onLearn: (gate: Gate) => void;
  /** The operator's edit to this gate is already in the runbook. */
  learned?: boolean;
};

export function ShieldedGate({ gate, target, open, capPct, keyOf, busy, onOpen, onCountersign, onReject, onLearn, learned = false }: Props): React.ReactElement {
  const current = gate.operatorFinalPatch ?? gate.agentProposedPatch;
  const [draft, setDraft] = useState(current);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setDraft(current), [current]);
  const edited = draft.trim() !== current.trim();
  const pending = gate.status === 'SHIELDED_PENDING';
  const over = gate.computedBlastRadiusPct > capPct;
  const rows = diffRows(draft, pending ? target : undefined);

  return (
    <article className={cn('rounded-xl p-3', gate.requiresHumanShield && pending ? 'tb-shield' : 'border border-border')}>
      <button type="button" onClick={onOpen} className="flex w-full items-start justify-between gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span>
          <span className="tb-head block text-sm">{keyOf(gate.targetNodeId)}</span>
          <span className="tb-readout text-[11px] text-muted-foreground">
            Staged by {gate.stagedBy} · {gate.status.replace(/_/g, ' ').toLowerCase()}
            {gate.approvedBy ? ` · ${gate.approvedBy}` : ''}
          </span>
        </span>
        <span className="text-right">
          <span className={cn('tb-dot block text-3xl', over ? 'text-[hsl(var(--tb-fault))]' : 'text-[hsl(var(--tb-trace))]')}>
            {gate.computedBlastRadiusPct}%
          </span>
          <span className="tb-readout text-[11px] text-muted-foreground">cap {capPct}%</span>
        </span>
      </button>

      {open ? (
        <div className="mt-2 space-y-2">
          {gate.requiresHumanShield && !pending ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <IconShieldLock className="size-4 shrink-0" />
              Shielded — {over ? `blast radius above the ${capPct}% agent cap` : 'CRITICAL_TIER_1 target'}. {gate.approvedBy ? `Countersigned by ${gate.approvedBy}.` : 'Closed without a countersignature.'}
            </p>
          ) : gate.requiresHumanShield ? (
            <p className="flex items-center gap-1.5 text-xs text-[hsl(var(--tb-amber))]">
              <IconShieldLock className="size-4 shrink-0" />
              Shield required — {over ? `blast radius above the ${capPct}% agent cap` : 'CRITICAL_TIER_1 target'}. Only you can countersign.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Within the agent cap; the agent may roll this out on its own.</p>
          )}
          <p className="tb-readout text-[11px] text-muted-foreground">
            HITS {gate.affectedNodeIds.map(keyOf).join(' · ')}
          </p>
          {rows && rows.length ? (
            <table className="tb-readout w-full text-xs">
              <caption className="sr-only">Fields this patch changes</caption>
              <tbody>
                {rows.map((r) => {
                  const changed = pending && r.before !== undefined && r.before !== r.after;
                  return (
                    <tr key={r.label} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="py-1.5 pr-2 text-left font-normal text-muted-foreground">{r.label}</th>
                      {pending ? (
                        <td className={cn('py-1.5 text-right', changed ? 'text-muted-foreground line-through decoration-[hsl(var(--tb-fault))]' : 'text-muted-foreground')}>
                          {fmt(r.before)}
                        </td>
                      ) : null}
                      {pending ? <td className="px-1.5 text-muted-foreground" aria-hidden="true">→</td> : null}
                      <td className="w-24 py-1">
                        {pending && typeof r.after === 'number' ? (
                          <input
                            type="number"
                            aria-label={`New ${r.label}`}
                            value={r.after}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                              const n = e.target.valueAsNumber;
                              if (Number.isFinite(n)) setDraft(writePath(draft, r.path, n));
                            }}
                            className="h-7 w-full rounded-md border border-border bg-transparent px-1.5 text-right text-[hsl(var(--tb-trace))] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        ) : (
                          <span className="block text-right">{fmt(r.after)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          <details className="group" open={!rows || rows.length === 0}>
            <summary className="tb-readout cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
              <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
              PATCH JSON
            </summary>
            <Textarea
              aria-label="Patch JSON"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={!pending}
              spellCheck={false}
              className="tb-readout mt-1.5 h-40 rounded-xl text-[11px]"
            />
          </details>
          <p className="tb-readout break-all text-[11px] text-muted-foreground">SHA-256 {gate.patchDiffHash}</p>
          {pending ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-8 rounded-full" disabled={busy} onClick={() => setConfirming(true)}>
                <IconShieldCheck className="size-4" />
                {edited ? 'Countersign edited patch' : 'Countersign & roll out'}
              </Button>
              <Button size="sm" variant="outline" className="h-8 rounded-full" disabled={busy} onClick={() => onReject(gate)}>
                <IconX className="size-4" /> Reject
              </Button>
            </div>
          ) : gate.operatorFinalPatch && gate.stagedBy === 'agent' && learned ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <IconBook className="size-4" /> Learned into the runbook
            </p>
          ) : gate.operatorFinalPatch && gate.stagedBy === 'agent' ? (
            <Button size="sm" variant="outline" className="h-8 rounded-full" disabled={busy} onClick={() => onLearn(gate)}>
              <IconBook className="size-4" /> Metabolize into runbook
            </Button>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent className="rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="tb-head">Countersign rollout on {keyOf(gate.targetNodeId)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {edited
                ? 'Your edited patch replaces the agent draft. TraceBench re-computes its blast radius and hash before applying.'
                : `This applies the exact patch with hash ${gate.patchDiffHash.slice(0, 12)}… and touches ${gate.affectedNodeIds.length} nodes (${gate.computedBlastRadiusPct}% blast radius).`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Hold</AlertDialogCancel>
            <AlertDialogAction className="rounded-xl" onClick={() => onCountersign(gate, edited ? draft : null)}>
              Countersign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
