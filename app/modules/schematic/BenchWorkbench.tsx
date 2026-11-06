import { actionErrorMessage, useActionMutation, useActionQuery, writeClientAppState } from '@agent-native/core/client/hooks';
import { defineClientAction } from '@agent-native/core/client/host';
import { createAgentNativeWebMcpRegistration } from '@agent-native/core/client/webmcp';
import { AgentToggleButton } from '@agent-native/toolkit/app/chat';
import { IconActivity, IconArrowLeft, IconBolt, IconFlag, IconMessageForward, IconRefreshDot, IconRestore, IconRocket, IconShieldLock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { sendToAgentChatAndConfirm } from '@agent-native/core/client/agent-chat';
import { adjacency, dependencies, dependents } from '@/lib/solver/graph';
import { canonicalPatch, parsePatch, patchImpact } from '@/lib/solver/patch';
import { TAB_ID } from '@/lib/tab-id';
import { cn } from '@/lib/utils';
import { ScopeEmblem } from '@/modules/shell/ScopeEmblem';
import { TemporalScrubber } from '@/modules/timeline/TemporalScrubber';

import { layeredLayout } from './layout';
import { type CanvasLink, type CanvasNode, type ProbeMetric, SchematicCanvas } from './SchematicCanvas';
import { RootCausePanel } from './RootCausePanel';
import { type Gate, ShieldedGate } from './ShieldedGate';

type GraphState = AgentNativeActionRegistry['get-graph-state']['result'];

const INFRA_METRICS: { value: ProbeMetric; label: string }[] = [
  { value: 'error_rate_pct', label: 'ERR %' },
  { value: 'p99_latency_ms', label: 'P99 MS' },
  { value: 'pool_saturation_pct', label: 'POOL %' },
];
const PCB_METRICS: { value: ProbeMetric; label: string }[] = [
  { value: 'voltage_v', label: 'V' },
  { value: 'current_a', label: 'A' },
];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errorCodeOf(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode : undefined;
}

// Units match log-probe so the optimistic pill reads the same as the stored sample.
// Room taken by the floating title bar, inspector and timeline on a desktop screen.
const FIT_INSET = { top: 12, right: 384, bottom: 128, left: 56 } as const;

const PROBE_UNITS = { voltage_v: 'V', p99_latency_ms: 'ms', error_rate_pct: '%', pool_saturation_pct: '%', current_a: 'A' } as const;

export function BenchWorkbench({ graphId }: { graphId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const args = useMemo(() => ({ id: graphId }), [graphId]);
  const queryKey = useMemo(() => ['action', 'get-graph-state', args], [args]);
  const { data, isPending, error } = useActionQuery('get-graph-state', args);
  const [previewSeq, setPreviewSeq] = useState<number | null>(null);
  const [patchDraft, setPatchDraft] = useState('');

  const selectedNodeId = params.get('node');
  const frameParam = params.get('frame');
  const committedSeq = frameParam !== null && /^\d+$/.test(frameParam) ? Number(frameParam) : null;
  const openGateId = params.get('gate');
  const shownSeq = previewSeq ?? committedSeq;

  const setParam = useCallback(
    (patch: Record<string, string | null>): void => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const rollback = (context: unknown): void => {
    queryClient.setQueryData(queryKey, (context as { previous?: unknown } | undefined)?.previous);
  };

  const probe = useActionMutation('log-probe', {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: GraphState | undefined) => {
        if (!old) return old;
        const optimisticProbe = {
          id: `optimistic-${Date.now()}`,
          nodeId: input.nodeId,
          metricName: input.metricName,
          measuredValue: input.value,
          unit: PROBE_UNITS[input.metricName],
          recordedBy: input.recordedBy ?? 'operator',
          createdAt: new Date().toISOString(),
        };
        return { ...old, probes: [optimisticProbe, ...old.probes] };
      });
      return { previous };
    },
    onSuccess: (r) => toast.success(`Probe logged on ${r.nodeKey} · frame #${r.frameSeq} · blast ${r.blastRadiusPct}%`),
    onError: (e, _input, context) => {
      rollback(context);
      toast.error(actionErrorMessage(e) ?? 'Probe failed.');
    },
  });
  const chaos = useActionMutation('inject-fault', {
    onSuccess: (r) => toast.success(`${r.fault} on ${r.nodeKey} · blast ${r.blastRadiusPct}%`),
    onError: (e) => toast.error(actionErrorMessage(e) ?? 'Injection failed.'),
  });
  const stage = useActionMutation('stage-patch', {
    onSuccess: (r) => {
      setPatchDraft('');
      setParam({ gate: r.id });
      toast.success(r.requiresHumanShield ? `Staged · ${r.computedBlastRadiusPct}% · shield required` : `Staged · ${r.computedBlastRadiusPct}% · within agent cap`);
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? 'Could not stage the patch.'),
  });
  const authorize = useActionMutation('authorize-rollout', {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: GraphState | undefined) =>
        old ? { ...old, gates: old.gates.map((g) => (g.id === input.gateId ? { ...g, status: 'APPROVED_APPLIED' as const } : g)) } : old,
      );
      return { previous };
    },
    onError: (e, _input, context) => {
      rollback(context);
      toast.error(errorCodeOf(e) === 'BLAST_RADIUS_CAP_EXCEEDED' ? 'Shield required: countersignature or hash did not verify.' : (actionErrorMessage(e) ?? 'Rollout failed.'));
    },
    onSuccess: (r) => {
      setParam({ frame: null });
      toast.success(`Rolled out · ${r.summary} · blast now ${r.blastRadiusAfterPct}%`);
    },
  });
  const reject = useActionMutation('reject-patch', {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: GraphState | undefined) =>
        old ? { ...old, gates: old.gates.map((g) => (g.id === input.gateId ? { ...g, status: 'REJECTED' as const } : g)) } : old,
      );
      return { previous };
    },
    onError: (e, _input, context) => {
      rollback(context);
      toast.error(actionErrorMessage(e) ?? 'Reject failed.');
    },
  });
  // Gates whose operator edit has been learned this session, so the button can't write the same rule twice.
  const [learnedGates, setLearnedGates] = useState<Set<string>>(() => new Set());
  const learn = useActionMutation('metabolize-runbook', {
    onSuccess: (r, input) => {
      setLearnedGates((prev) => new Set(prev).add(input.gateId));
      toast.success(`Runbook rule learned (${r.deltas.length} changed keys)${r.skillFileWritten ? ' · added to the agent skill' : ''}`);
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? 'Nothing to learn.'),
  });
  const seek = useActionMutation('seek-frame', {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: GraphState | undefined) =>
        old ? { ...old, activeFrameSeq: input.frameSeq ?? old.frames[old.frames.length - 1]?.seq ?? null } : old,
      );
      return { previous };
    },
    onError: (e, _input, context) => {
      rollback(context);
      toast.error(actionErrorMessage(e) ?? 'Seek failed.');
    },
    onSuccess: (r) => {
      if (r.restored) {
        setParam({ frame: null });
        toast.success(`Live state restored from frame — new frame #${r.newFrameSeq}`);
      }
    },
  });

  // ---- derived view: live state, or a historical frame while scrubbing
  const keyOf = useCallback((id: string): string => data?.nodes.find((n) => n.id === id)?.key ?? id, [data]);
  const shownFrame = shownSeq !== null ? data?.frames.find((f) => f.seq === shownSeq) ?? null : null;
  const replay = shownFrame !== null && shownSeq !== data?.frames[data.frames.length - 1]?.seq;
  const pcb = data?.graph.domainMode === 'hardware_pcb';

  // Positions come from the dependency structure, not hand placement.
  const layout = useMemo(
    () =>
      data
        ? layeredLayout(
            data.nodes.map((n) => ({ ...n, status: n.status })),
            data.links,
            data.graph.domainMode === 'hardware_pcb',
          )
        : new Map<string, { x: number; y: number }>(),
    [data],
  );

  const canvasNodes: CanvasNode[] = useMemo(() => {
    if (!data) return [];
    const snap = new Map((shownFrame?.nodes ?? []).map((n) => [n.id, n]));
    return data.nodes.map((n) => {
      const s = snap.get(n.id);
      const status = s?.status ?? n.status;
      const affected = s ? s.affected : data.diagnosis.affectedNodeIds.includes(n.id);
      const expected = s ? s.expectedVoltageV : n.expectedVoltageV;
      const measured = s ? s.measuredVoltageV : n.measuredVoltageV;
      return {
        id: n.id,
        key: n.key,
        label: n.label,
        tier: n.tier,
        x: layout.get(n.id)?.x ?? n.x,
        y: layout.get(n.id)?.y ?? n.y,
        status,
        affected,
        primary: pcb ? `${(measured ?? expected ?? 0).toFixed(2)} V` : `${Math.round(s?.effectiveLatencyMs ?? n.effectiveLatencyMs).toLocaleString()} ms`,
        secondary: pcb ? `of ${n.nominalVoltageV?.toFixed(1)} V` : `${(s?.errorRatePct ?? n.errorRatePct).toFixed(1)}% errors`,
      };
    });
  }, [data, shownFrame, pcb, layout]);

  const canvasLinks: CanvasLink[] = useMemo(
    () =>
      (data?.links ?? []).map((l) => ({
        id: l.id,
        sourceNodeId: l.sourceNodeId,
        targetNodeId: l.targetNodeId,
        couplingWeight: l.couplingWeight,
        status: l.status,
        label: pcb && l.currentA !== null ? `${l.currentA.toFixed(2)}A · ${(l.dropV ?? 0) * 1000 < 1 ? '<1' : ((l.dropV ?? 0) * 1000).toFixed(0)}mV` : null,
      })),
    [data, pcb],
  );

  const { upstream, blast } = useMemo(() => {
    if (!data) return { upstream: new Set<string>(), blast: new Map<string, number>() };
    const solverNodes = data.nodes.map((n) => ({ ...n, nominalVoltageV: n.nominalVoltageV, measuredVoltageV: n.measuredVoltageV, status: n.status, config: n.config }));
    const adj = adjacency(solverNodes, data.links);
    if (selectedNodeId) return { upstream: dependencies(adj, selectedNodeId), blast: dependents(adj, selectedNodeId) };
    const affected = new Map<string, number>();
    for (const n of canvasNodes) if (n.affected) affected.set(n.id, n.status === 'FAULT' ? 1 : 0.5);
    return { upstream: new Set<string>(), blast: affected };
  }, [data, selectedNodeId, canvasNodes]);

  // Share the solver-derived selection with the agent (tab-scoped).
  useEffect(() => {
    if (!data) return;
    void writeClientAppState(
      `bench-selection:${TAB_ID}`,
      selectedNodeId
        ? {
            graphId,
            selectedNodeId,
            selectedKey: keyOf(selectedNodeId),
            upstreamPath: [...upstream].filter((id) => id !== selectedNodeId).map(keyOf),
            downstreamBlastRadius: [...blast.keys()].filter((id) => id !== selectedNodeId).map(keyOf),
            activeFrameIndex: committedSeq,
          }
        : { graphId, selectedNodeId: null, activeFrameIndex: committedSeq },
      { requestSource: TAB_ID },
    );
  }, [data, graphId, selectedNodeId, upstream, blast, committedSeq, keyOf]);

  // Browser-side tools for an external agent driving this tab: point the probe, dry-run a patch.
  const dataRef = useRef(data);
  dataRef.current = data;
  const setParamRef = useRef(setParam);
  setParamRef.current = setParam;
  useEffect((): (() => void) => {
    const solverView = (): { nodes: Parameters<typeof adjacency>[0]; links: Parameters<typeof adjacency>[1] } | null => {
      const g = dataRef.current;
      return g ? { nodes: g.nodes.map((n) => ({ ...n, config: n.config })), links: g.links } : null;
    };
    const registration = createAgentNativeWebMcpRegistration({
      actions: [
        defineClientAction<{ nodeKey: string }, unknown>({
          name: 'select-schematic-node',
          title: 'Select a node on the open schematic',
          description:
            'Put the operator probe on a node of the open TraceBench graph (by node_key). Highlights its upstream path and downstream blast radius and returns both.',
          schema: {
            type: 'object',
            properties: { nodeKey: { type: 'string', description: 'graph_nodes.node_key, e.g. payments-db or buck-3v3' } },
            required: ['nodeKey'],
          },
          run: async ({ nodeKey }) => {
            const g = dataRef.current;
            const view = solverView();
            if (!g || !view) return { error: 'No graph is open.' };
            const node = g.nodes.find((n) => n.key === nodeKey || n.id === nodeKey);
            if (!node) return { error: `No node ${nodeKey} on ${g.graph.name}.` };
            setParamRef.current({ node: node.id });
            const adj = adjacency(view.nodes, view.links);
            const keyFor = (id: string): string => g.nodes.find((n) => n.id === id)?.key ?? id;
            return {
              nodeKey: node.key,
              status: node.status,
              upstreamPath: [...dependencies(adj, node.id)].filter((id) => id !== node.id).map(keyFor),
              downstreamBlastRadius: [...dependents(adj, node.id).keys()].filter((id) => id !== node.id).map(keyFor),
            };
          },
        }),
        defineClientAction<{ patch: string }, unknown>({
          name: 'dry-run-patch',
          title: 'Dry-run a remediation patch',
          description:
            'Run the blast-radius solver in this tab on a patch JSON without staging it. Use it to find the smallest patch that stays under the agent cap before calling stage-patch.',
          schema: {
            type: 'object',
            properties: { patch: { type: 'string', description: 'Patch JSON, same shape stage-patch accepts' } },
            required: ['patch'],
          },
          readOnly: true,
          run: async ({ patch }) => {
            const g = dataRef.current;
            const view = solverView();
            if (!g || !view) return { error: 'No graph is open.' };
            const parsed = parsePatch(patch);
            if (!parsed.ok) return { error: parsed.error };
            const impact = patchImpact(parsed.patch, view.nodes, view.links);
            if (!impact) return { error: `Unknown target ${parsed.patch.target}.` };
            const target = g.nodes.find((n) => n.id === impact.targetNodeId);
            const cap = g.graph.agentBlastCapPct;
            return {
              blastRadiusPct: impact.blastRadiusPct,
              agentCapPct: cap,
              wouldRequireShield: impact.blastRadiusPct > cap || target?.tier === 'CRITICAL_TIER_1',
              affected: impact.affectedNodeIds.map((id) => g.nodes.find((n) => n.id === id)?.key ?? id),
            };
          },
        }),
      ],
      getContext: () => ({ route: { name: window.location.pathname } }),
    });
    void registration.start();
    return (): void => registration.stop();
  }, [graphId]);

  if (error) {
    return (
      <main className="p-8">
        <p className="text-sm text-muted-foreground">{actionErrorMessage(error) ?? 'Bench not found.'}</p>
        <Link to="/bench" className="mt-2 inline-block text-sm underline">Back to benches</Link>
      </main>
    );
  }
  if (isPending || !data) return <BenchSkeleton />;

  const selected = data.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const pendingGates = data.gates.filter((g) => g.status === 'SHIELDED_PENDING');
  const historyGates = data.gates.filter((g) => g.status !== 'SHIELDED_PENDING');
  // Runbook rules learned on this bench's own nodes; a rule for another bench's service doesn't belong here.
  const benchRules = data.learnedRules.filter((r) => data.nodes.some((n) => n.key === r.nodeKey));
  // The gate being reviewed (the open one, else the first pending) is drawn on the graph: its target and every node it hits.
  const reviewGate = pendingGates.find((g) => g.id === openGateId) ?? pendingGates[0];
  const patchOverlay = reviewGate
    ? { targetId: reviewGate.targetNodeId, hits: new Set(reviewGate.affectedNodeIds), pct: reviewGate.computedBlastRadiusPct, capPct: data.graph.agentBlastCapPct }
    : null;
  const renderGate = (g: Gate): React.ReactElement => (
    <ShieldedGate
      key={g.id}
      gate={g}
      target={data.nodes.find((n) => n.id === g.targetNodeId)}
      open={openGateId === g.id}
      capPct={data.graph.agentBlastCapPct}
      keyOf={keyOf}
      busy={authorize.isPending || reject.isPending || learn.isPending}
      onOpen={() => setParam({ gate: openGateId === g.id ? null : g.id })}
      onCountersign={(gate, edited) => void countersign(gate, edited)}
      onReject={(gate) => reject.mutate({ graphId, gateId: gate.id })}
      learned={learnedGates.has(g.id)}
      onLearn={(gate) => learn.mutate({ graphId, gateId: gate.id })}
    />
  );

  const gateSection = (
    <section className="space-y-2" aria-label="Shielded gate">
      <h2 className={cn('flex items-center gap-2 text-[13px] font-semibold', pendingGates.length ? 'text-[hsl(var(--tb-trace))]' : undefined)}>
        <IconShieldLock className="size-4 text-[hsl(var(--tb-trace))]" />
        {pendingGates.length ? `Waiting on you · ${pendingGates.length} gate${pendingGates.length > 1 ? 's' : ''}` : 'Shielded gate'}
      </h2>
      {pendingGates.length === 0 ? (
        <p className="text-xs text-muted-foreground">{data.gates.length ? 'Nothing waiting on you.' : 'No patches staged yet.'}</p>
      ) : (
        pendingGates.map(renderGate)
      )}
    </section>
  );

  function askAgent(nodeId?: string): void {
    if (!data) return;
    const focus = nodeId ? (data.nodes.find((n) => n.id === nodeId) ?? null) : selected;
    if (nodeId) setParam({ node: nodeId });
    const message = focus
      ? `Isolate the fault around ${focus.key} (${focus.status}). Check its upstream path, probe if needed, and stage the smallest patch that clears it — respect the ${data.graph.agentBlastCapPct}% blast cap.`
      : `Diagnose "${data.graph.name}": rank root causes, then stage the smallest safe patch. Faults: ${data.diagnosis.faultNodeIds.map(keyOf).join(', ') || 'none detected'}.`;
    const context = JSON.stringify({ graphId: data.graph.id, selectedNodeId: focus?.id ?? selectedNodeId, activeFrameIndex: committedSeq, openGateId });
    void (async () => {
      for (const timeoutMs of [2600, 6200]) {
        const res = await sendToAgentChatAndConfirm({ message, context, submit: true, openSidebar: true, chatTarget: 'local' }, { timeoutMs });
        if (res.delivered) break;
      }
    })();
  }

  async function countersign(gate: Gate, operatorPatch: string | null): Promise<void> {
    const text = operatorPatch ?? gate.operatorFinalPatch ?? gate.agentProposedPatch;
    const hash = operatorPatch ? await sha256Hex(canonicalPatch(operatorPatch)) : gate.patchDiffHash;
    authorize.mutate({
      graphId,
      gateId: gate.id,
      humanCountersigned: true,
      patchDiffHash: hash,
      ...(operatorPatch ? { operatorFinalPatch: text } : {}),
    });
  }

  const defaultPatch = selected
    ? JSON.stringify(
        pcb
          ? { kind: 'isolate', target: selected.key, note: 'cut the faulted rail' }
          : { kind: 'config', target: selected.key, set: { errorRatePct: 0.5 }, note: 'describe the remediation' },
        null,
        2,
      )
    : '';

  // While replaying, the status pill describes the frame on screen, not the live bench.
  const blastPct = replay && shownFrame ? shownFrame.blastRadiusPct : data.diagnosis.blastRadiusPct;
  const faults = (replay && shownFrame ? shownFrame.nodes.filter((n) => n.status === 'FAULT').map((n) => n.id) : data.diagnosis.faultNodeIds).map(
    (id) => data.nodes.find((n) => n.id === id)?.label ?? keyOf(id),
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background p-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-[hsl(var(--tb-ground))]">
      {/* Breadcrumb bar: where you are, how bad it is, and the two things you can do from anywhere. */}
      <header className="z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-[hsl(var(--tb-ground))] px-3">
        <Link to="/bench" aria-label="All benches" className="grid size-8 place-items-center rounded-lg hover:bg-accent">
          <ScopeEmblem />
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <Link to="/bench" className="rounded-md px-1.5 py-1 text-[14px] text-muted-foreground hover:bg-accent hover:text-foreground">
          Benches
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <h1 className="tb-head min-w-0 truncate text-[14px]">{data.graph.name}</h1>
        <span
          className={cn(
            'ml-1 hidden shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] sm:inline-flex',
            faults.length ? 'border-[hsl(var(--tb-fault)/0.4)] text-[hsl(var(--tb-fault))]' : 'border-border text-muted-foreground',
          )}
          title={data.diagnosis.cyclicSccs.length ? `Cycle: ${data.diagnosis.cyclicSccs.map((c) => c.map(keyOf).join(' ⇄ ')).join('; ')}` : undefined}
        >
          <span className={cn('size-1.5 rounded-full', faults.length ? 'bg-[hsl(var(--tb-fault))]' : 'bg-[hsl(148_60%_48%)]')} />
          {replay && shownFrame ? `Replaying frame ${shownFrame.seq} · ` : ''}{faults.length ? `${blastPct}% of traffic hit · ${faults.join(', ')}` : 'All services healthy'}
        </span>
        {!pcb ? <span className="hidden shrink-0 text-[12px] text-muted-foreground xl:inline">Critical path {data.diagnosis.criticalPathLatencyMs.toLocaleString()} ms</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" className="h-8 rounded-lg px-3.5" onClick={() => askAgent()}>
            <IconMessageForward className="size-4" /> Ask agent
          </Button>
          <AgentToggleButton />
        </div>
      </header>

      <div className="tb-dotgrid relative min-h-0 flex-1 overflow-hidden max-lg:flex max-lg:flex-col max-lg:overflow-y-auto">
      <div className="relative min-h-[420px] max-lg:flex-1 lg:absolute lg:inset-0">
        <SchematicCanvas
          nodes={canvasNodes}
          links={canvasLinks}
          selectedNodeId={selectedNodeId}
          upstream={upstream}
          blast={blast}
          patch={patchOverlay}
          replay={replay}
          fitInset={FIT_INSET}
          metrics={pcb ? PCB_METRICS : INFRA_METRICS}
          probePending={probe.isPending}
          onSelect={(id) => setParam({ node: id })}
          onProbe={(nodeId, metricName, value) => probe.mutate({ graphId, nodeId, metricName, value, recordedBy: 'operator' })}
        />
      </div>


        <aside className="tb-float z-10 m-3 space-y-5 overflow-y-auto p-4 lg:absolute lg:bottom-3 lg:right-3 lg:top-3 lg:m-0 lg:w-[360px]">
          {/* Anything waiting on the operator goes first, above the node details. */}
          {pendingGates.length ? gateSection : null}
          {selected ? (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="tb-head text-lg font-bold">{selected.label}</h2>
                <span className="tb-readout text-[11px] text-muted-foreground">{selected.key} · {selected.tier}</span>
              </div>
              <dl className="tb-readout grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {pcb ? (
                  <>
                    <div><dt className="text-muted-foreground">Expected</dt><dd>{selected.expectedVoltageV?.toFixed(3)}V</dd></div>
                    <div><dt className="text-muted-foreground">Measured</dt><dd>{selected.measuredVoltageV?.toFixed(3) ?? '—'}V</dd></div>
                    <div><dt className="text-muted-foreground">Nominal</dt><dd>{selected.nominalVoltageV}V</dd></div>
                    <div><dt className="text-muted-foreground">Current</dt><dd>{selected.currentA?.toFixed(3)}A</dd></div>
                  </>
                ) : (
                  <>
                    <div><dt className="text-muted-foreground">Latency</dt><dd>{selected.effectiveLatencyMs}ms</dd></div>
                    <div><dt className="text-muted-foreground">Base latency</dt><dd>{selected.baseLatencyMs}ms</dd></div>
                    <div><dt className="text-muted-foreground">Errors</dt><dd>{selected.errorRatePct}%</dd></div>
                    <div><dt className="text-muted-foreground">Failure odds</dt><dd>{(selected.failProbability * 100).toFixed(1)}%</dd></div>
                  </>
                )}
                <div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div>
                <div><dt className="text-muted-foreground">Root score</dt><dd>{selected.rootCauseScore}</dd></div>
              </dl>
              <p className="tb-readout text-[11px] text-[hsl(var(--tb-amber))]">Depends on {[...upstream].filter((i) => i !== selected.id).map(keyOf).join(' · ') || '—'}</p>
              <p className="tb-readout text-[11px] text-[hsl(var(--tb-fault))]">Hits {[...blast.keys()].filter((i) => i !== selected.id).map(keyOf).join(' · ') || '—'}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {pcb ? (
                  <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={chaos.isPending} onClick={() => chaos.mutate({ graphId, nodeId: selected.id, fault: 'rail_short', value: 0.2 })}>
                    <IconBolt className="size-3.5" /> Short rail 0.2Ω
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={chaos.isPending} onClick={() => chaos.mutate({ graphId, nodeId: selected.id, fault: 'error_burst', value: 40 })}>
                    <IconBolt className="size-3.5" /> Error burst 40%
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={chaos.isPending} onClick={() => chaos.mutate({ graphId, nodeId: selected.id, fault: 'recover' })}>
                  <IconRefreshDot className="size-3.5" /> Recover
                </Button>
              </div>
              <div className="space-y-1.5 pt-2">
                <h3 className="text-[13px] font-semibold">Stage a patch</h3>
                <Textarea
                  aria-label="Patch JSON to stage"
                  value={patchDraft || defaultPatch}
                  onChange={(e) => setPatchDraft(e.target.value)}
                  spellCheck={false}
                  className="tb-readout h-28 rounded-xl text-[11px]"
                />
                <Button size="sm" className="h-8 w-full rounded-full" disabled={stage.isPending} onClick={() => stage.mutate({ graphId, patch: patchDraft || defaultPatch, stagedBy: 'operator' })}>
                  Compute blast radius & stage
                </Button>
              </div>
            </section>
          ) : (
            <>
              <RootCausePanel data={data} onInvestigate={(id) => setParam({ node: id })} onAsk={(id) => askAgent(id)} />
              <ActivityFeed frames={data.frames} />
            </>
          )}

          {pendingGates.length ? null : gateSection}

          {historyGates.length ? (
            <details className="group space-y-2" open={historyGates.some((g) => g.id === openGateId)}>
              <summary className="tb-readout cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
                GATE HISTORY · {historyGates.length}
              </summary>
              <div className="space-y-2 pt-2 opacity-80">{historyGates.map(renderGate)}</div>
            </details>
          ) : null}

          {benchRules.length ? (
            <section className="space-y-1">
              <h2 className="text-[13px] font-semibold">Runbook, learned from operator edits</h2>
              <ol className="space-y-1.5">
                {benchRules.slice(0, 5).map((r) => (
                  <li key={r.id} className="border-l-2 border-[hsl(var(--tb-amber))] pl-2">
                    <span className="tb-readout text-[11px] text-muted-foreground">{r.nodeKey} · {r.createdAt.slice(0, 10)}</span>
                    <p className="whitespace-pre-line text-[11px] leading-snug">{r.rule.replace(/^- /gm, '').replace(/`/g, '')}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {data.probes.length ? (
            <section className="space-y-1">
              <h2 className="text-[13px] font-semibold">Probe log</h2>
              <ol className="tb-readout space-y-0.5 text-[11px]">
                {data.probes.slice(0, 12).map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <span className="truncate">{keyOf(p.nodeId)} {p.metricName}</span>
                    <span>{p.measuredValue}{p.unit} <span className="text-muted-foreground">{p.recordedBy === 'operator' ? 'OP' : 'AG'}</span></span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </aside>

      <div className="tb-float z-10 m-3 overflow-hidden lg:absolute lg:bottom-3 lg:left-3 lg:right-[384px] lg:m-0">
        <TemporalScrubber
        frames={data.frames}
        activeSeq={shownSeq}
        onPreview={setPreviewSeq}
        onCommit={(seq) => {
          setPreviewSeq(null);
          setParam({ frame: seq === null ? null : String(seq) });
          if (seq !== null) seek.mutate({ graphId, frameSeq: seq });
        }}
        onRestore={(seq) => seek.mutate({ graphId, frameSeq: seq, restore: true })}
        />
      </div>
      </div>
      </div>
    </div>
  );
}

function BenchSkeleton(): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <Skeleton className="size-4" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="ml-auto h-4 w-72" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="tb-ground relative flex-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="absolute h-[54px] w-[150px]" style={{ left: 40 + (i % 3) * 200, top: 60 + Math.floor(i / 3) * 140 }} />
          ))}
        </div>
        <div className="hidden w-[360px] space-y-2 p-4 lg:block">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <Skeleton className="mb-2 h-4 w-48" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}

const ACTIVITY_ICON: Record<string, typeof IconBolt> = {
  seed: IconFlag,
  probe: IconActivity,
  chaos: IconBolt,
  patch_staged: IconShieldLock,
  rollout: IconRocket,
  restore: IconRestore,
};

function clock(us: number): string {
  const s = Math.max(0, Math.floor(us / 1_000_000));
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  // Past an hour, show h:mm:ss rather than a three-digit minute count.
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : mmss;
}

// The bench's recent history as a feed: what happened, to what, and when in the incident.
function ActivityFeed({ frames }: { frames: AgentNativeActionRegistry['get-graph-state']['result']['frames'] }): React.ReactElement {
  const items = [...frames].reverse().slice(0, 8);
  const origin = frames[0]?.timestampUs ?? 0;
  return (
    <section aria-label="Activity">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <IconActivity className="size-4 text-[hsl(var(--tb-trace))]" /> Activity
      </h2>
      <ol className="mt-2 divide-y divide-border">
        {items.map((f) => {
          const Icon = ACTIVITY_ICON[f.eventType] ?? IconActivity;
          return (
            <li key={f.seq} className="flex gap-3 py-2.5">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium capitalize leading-snug">{f.eventType.replace(/_/g, ' ')}</p>
                <p className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{f.summary}</p>
              </div>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{clock(f.timestampUs - origin)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
