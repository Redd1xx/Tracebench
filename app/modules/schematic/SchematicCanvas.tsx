import {
  IconAlertTriangle,
  IconArrowsMinimize,
  IconBolt,
  IconCircleCheck,
  IconCircleX,
  IconCloud,
  IconDatabase,
  IconMinus,
  IconPlugConnectedX,
  IconPlus,
  IconServer2,
  IconStack2,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { NODE_H, NODE_W } from './layout';

export type CanvasNode = {
  id: string;
  key: string;
  label: string;
  tier: 'CRITICAL_TIER_1' | 'TIER_2' | 'EDGE';
  x: number;
  y: number;
  status: 'HEALTHY' | 'DEGRADED' | 'FAULT' | 'ISOLATED';
  affected: boolean;
  primary: string;
  secondary: string;
};

// A service's kind, read from its key, picks the icon on its card.
function ServiceIcon({ node }: { node: CanvasNode }): React.ReactElement {
  const k = `${node.key} ${node.label}`.toLowerCase();
  const cls = 'size-[18px] shrink-0 text-muted-foreground';
  if (/(^|[-\s])(db|pg|postgres|database|ledger)/.test(k)) return <IconDatabase className={cls} />;
  if (/kafka|queue|events|stream/.test(k)) return <IconStack2 className={cls} />;
  if (/cdn|edge|gateway/.test(k)) return <IconCloud className={cls} />;
  if (/rail|buck|ldo|vin|3v3|5v|1v8|regulator/.test(k)) return <IconBolt className={cls} />;
  return <IconServer2 className={cls} />;
}

const STATUS_LINE: Record<CanvasNode['status'], { label: string; tone: string; Icon: typeof IconCircleCheck }> = {
  HEALTHY: { label: 'Healthy', tone: 'text-[hsl(148_60%_48%)]', Icon: IconCircleCheck },
  DEGRADED: { label: 'Degraded', tone: 'text-[hsl(var(--tb-amber))]', Icon: IconAlertTriangle },
  FAULT: { label: 'Failing', tone: 'text-[hsl(var(--tb-fault))]', Icon: IconCircleX },
  ISOLATED: { label: 'Isolated', tone: 'text-muted-foreground', Icon: IconPlugConnectedX },
};

export type CanvasLink = { id: string; sourceNodeId: string; targetNodeId: string; couplingWeight: number; status: 'ACTIVE' | 'CUT'; label: string | null };

export type ProbeMetric = 'voltage_v' | 'p99_latency_ms' | 'error_rate_pct' | 'pool_saturation_pct' | 'current_a';

type Props = {
  nodes: CanvasNode[];
  links: CanvasLink[];
  selectedNodeId: string | null;
  upstream: Set<string>;
  blast: Map<string, number>;
  /** A staged patch awaiting review: its target and every node it would hit. */
  patch?: { targetId: string; hits: Set<string>; pct: number; capPct: number } | null;
  replay: boolean;
  /** Space covered by floating panels (px); the graph fits and centres in what is left. */
  fitInset?: { top: number; right: number; bottom: number; left: number };
  metrics: { value: ProbeMetric; label: string }[];
  probePending: boolean;
  onSelect: (nodeId: string | null) => void;
  onProbe: (nodeId: string, metric: ProbeMetric, value: number) => void;
};


const STATUS_STROKE: Record<CanvasNode['status'], string> = {
  HEALTHY: 'hsl(var(--tb-trace))',
  DEGRADED: 'hsl(var(--tb-amber))',
  FAULT: 'hsl(var(--tb-fault))',
  ISOLATED: 'hsl(var(--tb-ink) / 0.35)',
};

// Links run between node edges: bottom → top when the target sits lower,
// top → bottom when higher, and side → side within a layer (cycles).
type LinkGeometry = { d: string; mid: { x: number; y: number } };

// Cubic Bézier through four points; the label sits at t = 0.5, always upright.
function cubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): LinkGeometry {
  return {
    d: `M ${p0[0]} ${p0[1]} C ${p1[0]} ${p1[1]}, ${p2[0]} ${p2[1]}, ${p3[0]} ${p3[1]}`,
    mid: { x: (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8, y: (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8 },
  };
}

function linkPath(a: CanvasNode, b: CanvasNode): LinkGeometry {
  const ax = a.x + NODE_W / 2;
  const bx = b.x + NODE_W / 2;
  if (Math.abs(a.y - b.y) < NODE_H / 2) {
    const right = bx > ax;
    const sx = right ? a.x + NODE_W : a.x;
    const ex = right ? b.x : b.x + NODE_W;
    const sy = a.y + NODE_H * 0.35;
    const ey = b.y + NODE_H * 0.65;
    const bend = Math.max(30, Math.abs(ex - sx) / 2);
    return cubic([sx, sy], [sx + (right ? bend : -bend), sy], [ex - (right ? bend : -bend), ey], [ex, ey]);
  }
  const down = b.y > a.y;
  const sy = down ? a.y + NODE_H : a.y;
  const ey = down ? b.y : b.y + NODE_H;
  const bend = Math.max(28, Math.abs(ey - sy) / 2);
  return cubic([ax, sy], [ax, sy + (down ? bend : -bend)], [bx, ey - (down ? bend : -bend)], [bx, ey]);
}

export function SchematicCanvas({ nodes, links, selectedNodeId, upstream, blast, patch, replay, fitInset, metrics, probePending, onSelect, onProbe }: Props): React.ReactElement {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const view = useRef({ tx: 24, ty: 24, k: 1 });
  const pan = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const [probeOpen, setProbeOpen] = useState(false);
  const [metric, setMetric] = useState<ProbeMetric>(metrics[0]?.value ?? 'error_rate_pct');
  const [value, setValue] = useState('');
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const width = Math.max(...nodes.map((n) => n.x + NODE_W), 600) + 80;
  const height = Math.max(...nodes.map((n) => n.y + NODE_H), 400) + 80;

  const apply = useCallback((): void => {
    const el = stageRef.current;
    if (!el) return;
    const { tx, ty, k } = view.current;
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${k})`;
  }, []);

  // Fit the whole schematic into the frame once per graph extent (and on demand from the zoom stack).
  const [fitTick, setFitTick] = useState(0);
  const zoomBy = (factor: number): void => {
    const frame = frameRef.current;
    if (!frame) return;
    const cx = frame.clientWidth / 2;
    const cy = frame.clientHeight / 2;
    const { tx, ty, k } = view.current;
    const nk = Math.min(3, Math.max(0.35, k * factor));
    view.current = { k: nk, tx: cx - ((cx - tx) * nk) / k, ty: cy - ((cy - ty) * nk) / k };
    apply();
  };
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // Fit the whole graph on a laptop screen; only very large graphs fall back to panning.
    const inset = frame.clientWidth >= 1024 && fitInset ? fitInset : { top: 0, right: 0, bottom: 0, left: 0 };
    const availW = frame.clientWidth - inset.left - inset.right;
    const availH = frame.clientHeight - inset.top - inset.bottom;
    const k = Math.max(0.6, Math.min(1.4, (availW - 48) / width, (availH - 48) / height));
    // Centre what fits in the uncovered area; otherwise start at its top/left edge and pan.
    const tx = inset.left + (width * k <= availW ? (availW - width * k) / 2 : 16);
    const ty = inset.top + (height * k <= availH ? (availH - height * k) / 2 : 8);
    view.current = { k, tx, ty };
    apply();
  }, [width, height, apply, fitTick, fitInset?.top, fitInset?.right, fitInset?.bottom, fitInset?.left]);

  useEffect(() => {
    apply();
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = frame.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { tx, ty, k } = view.current;
      const nk = Math.min(3, Math.max(0.35, k * Math.exp(-e.deltaY * 0.0015)));
      view.current = { k: nk, tx: cx - ((cx - tx) * nk) / k, ty: cy - ((cy - ty) * nk) / k };
      apply();
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [apply]);

  useEffect(() => {
    setProbeOpen(false);
    setValue('');
  }, [selectedNodeId]);

  const selected = selectedNodeId ? byId.get(selectedNodeId) ?? null : null;

  return (
    <div
      ref={frameRef}
      className={`relative h-full min-h-[380px] w-full overflow-hidden ${replay ? 'tb-replay' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('[data-node],[data-pill]')) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        pan.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false };
      }}
      onPointerMove={(e) => {
        const p = pan.current;
        if (!p) return;
        if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 3) p.moved = true;
        view.current.tx = p.tx + e.clientX - p.x;
        view.current.ty = p.ty + e.clientY - p.y;
        apply();
      }}
      onPointerUp={() => {
        if (pan.current && !pan.current.moved) onSelect(null);
        pan.current = null;
      }}
    >
      {/* Zoom stack, top left: the canvas controls a service map keeps at hand. */}
      <div
        className="absolute left-3 top-3 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)} className="grid size-8 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground">
          <IconPlus className="size-4" />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} className="grid size-8 place-items-center border-t border-border text-muted-foreground hover:bg-accent hover:text-foreground">
          <IconMinus className="size-4" />
        </button>
        <button type="button" aria-label="Fit to screen" onClick={() => setFitTick((t) => t + 1)} className="grid size-8 place-items-center border-t border-border text-muted-foreground hover:bg-accent hover:text-foreground">
          <IconArrowsMinimize className="size-4" />
        </button>
      </div>
      {replay ? (
        <span className="tb-readout pointer-events-none absolute right-3 top-3 z-10 bg-[hsl(var(--tb-fault))] px-2.5 py-0.5 text-[11px] text-white rounded-full">Replay</span>
      ) : null}
      <div ref={stageRef} className="absolute left-0 top-0 origin-top-left" style={{ width, height, willChange: 'transform' }}>
        <svg width={width} height={height} className="absolute inset-0 overflow-visible">
          <defs>
            <marker id="tb-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="hsl(var(--tb-ink) / 0.45)" />
            </marker>
          </defs>
          {links.map((l) => {
            const a = byId.get(l.sourceNodeId);
            const b = byId.get(l.targetNodeId);
            if (!a || !b) return null;
            const hot = blast.has(l.sourceNodeId) && blast.has(l.targetNodeId);
            const up = upstream.has(l.sourceNodeId) && upstream.has(l.targetNodeId);
            const { d, mid } = linkPath(a, b);
            return (
              <g key={l.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={l.status === 'CUT' ? 'hsl(var(--tb-ink) / 0.15)' : hot ? 'hsl(var(--tb-fault) / 0.8)' : up ? 'hsl(var(--tb-amber) / 0.9)' : 'hsl(var(--tb-ink) / 0.32)'}
                  strokeWidth={hot || up ? 1.75 : 1.25}
                  strokeDasharray={l.status === 'CUT' ? '2 6' : '5 5'}
                  markerEnd="url(#tb-arrow)"
                />
                {l.label ? (
                  <text
                    x={mid.x + 6}
                    y={mid.y}
                    dominantBaseline="middle"
                    className="tb-readout"
                    fontSize="11"
                    fill="hsl(var(--tb-ink) / 0.7)"
                    stroke="hsl(var(--tb-ground))"
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {l.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {nodes.map((n) => {
          const strength = blast.get(n.id);
          const isSel = n.id === selectedNodeId;
          const hit = patch?.hits.has(n.id) ?? false;
          const isTarget = patch?.targetId === n.id;
          const over = patch ? patch.pct > patch.capPct : false;
          return (
            <button
              key={n.id}
              type="button"
              data-node
              onClick={() => onSelect(isSel ? null : n.id)}
              className="absolute flex flex-col justify-between rounded-xl bg-card px-3.5 py-3 text-left shadow-[0_8px_24px_-14px_rgb(0_0_0/0.7)] outline-none transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                left: n.x,
                top: n.y,
                width: NODE_W,
                height: NODE_H,
                // Selection is the thick purple frame; a failing service carries a red frame; everything else stays quiet.
                border: isSel
                  ? '3px solid hsl(var(--tb-trace))'
                  : n.status === 'FAULT'
                    ? '2px solid hsl(var(--tb-fault) / 0.85)'
                    : `1px ${n.status === 'ISOLATED' ? 'dashed' : 'solid'} hsl(var(--border))`,
                boxShadow:
                  strength !== undefined && !isSel && n.status !== 'FAULT'
                    ? `0 0 0 1px hsl(var(--tb-fault) / ${0.25 + strength * 0.35}), 0 8px 24px -14px rgb(0 0 0 / 0.7)`
                    : upstream.has(n.id) && !isSel
                      ? '0 0 0 1px hsl(var(--tb-amber) / 0.6)'
                      : undefined,
                outline: hit ? `${isTarget ? 2 : 1.5}px dashed hsl(var(--tb-trace))` : undefined,
                outlineOffset: hit ? 6 : undefined,
              }}
            >
              {isTarget && patch ? (
                <span
                  className={`pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium text-white ${over ? 'bg-[hsl(var(--tb-fault))]' : 'bg-[hsl(var(--tb-trace))]'}`}
                >
                  Patch reaches {patch.pct}% · cap {patch.capPct}%
                </span>
              ) : null}
              <span className="flex min-w-0 items-center gap-2.5">
                <ServiceIcon node={n} />
                <span className="tb-head truncate text-[14px]">{n.label}</span>
                {n.tier === 'CRITICAL_TIER_1' ? <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Tier 1</span> : null}
              </span>
              {(() => {
                const st = STATUS_LINE[n.status];
                return (
                  <span className={`flex min-w-0 items-center gap-1.5 text-[12.5px] ${st.tone}`}>
                    <st.Icon className="size-4 shrink-0" />
                    <span className="truncate tabular-nums">
                      {st.label} · <span className="text-muted-foreground">{n.secondary.startsWith('of ') ? `${n.primary} ${n.secondary}` : n.status === 'FAULT' ? n.secondary : n.primary}</span>
                    </span>
                  </span>
                );
              })()}
            </button>
          );
        })}
        {selected && !replay ? (
          <div data-pill className="absolute z-20 flex items-center gap-1" style={{ left: selected.x + NODE_W + 10, top: selected.y + 8 }}>
            <span className="h-px w-3 bg-[hsl(var(--tb-trace))]" />
            {probeOpen ? (
              <form
                className="flex items-center gap-1 rounded-full border border-[hsl(var(--tb-trace))] bg-card py-0.5 pl-2 pr-1 shadow-lg"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(value);
                  if (!value.trim() || !Number.isFinite(v)) return;
                  onProbe(selected.id, metric, v);
                  setValue('');
                  setProbeOpen(false);
                }}
              >
                <select
                  aria-label="Probe metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as ProbeMetric)}
                  className="tb-readout bg-transparent text-[11px] outline-none"
                >
                  {metrics.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <input
                  autoFocus
                  aria-label="Probe reading"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="tb-readout w-16 bg-transparent text-right text-[12px] outline-none"
                  placeholder="0.00"
                />
                <button type="submit" disabled={probePending} className="tb-readout rounded-full bg-[hsl(var(--tb-trace))] px-2 text-[11px] text-black">LOG</button>
                <button type="button" aria-label="Close probe" onClick={() => setProbeOpen(false)} className="p-0.5 text-muted-foreground">
                  <IconX className="size-3" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setProbeOpen(true)}
                className="tb-readout flex items-center gap-1 rounded-full border border-[hsl(var(--tb-trace))] bg-card px-2 py-0.5 text-[11px] text-[hsl(var(--tb-trace))]"
              >
                <IconPlus className="size-3" /> Probe
              </button>
            )}
          </div>
        ) : null}
      </div>
      <p className={`tb-readout pointer-events-none absolute bottom-2 left-3 text-[11px] text-muted-foreground max-md:hidden ${fitInset ? 'hidden' : ''}`}>
        scroll = zoom · drag = pan · arrows: u → v means u depends on v
      </p>
    </div>
  );
}
