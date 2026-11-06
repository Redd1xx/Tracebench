import { IconPlayerTrackNext, IconRestore } from '@tabler/icons-react';
import { useCallback, useEffect, useRef } from 'react';

export type TimelineFrame = { seq: number; eventType: string; summary: string; blastRadiusPct: number; timestampUs: number };

type Props = {
  frames: TimelineFrame[];
  activeSeq: number | null;
  onPreview: (seq: number) => void;
  onCommit: (seq: number | null) => void;
  onRestore: (seq: number) => void;
};

const EVENT_TONE: Record<string, string> = {
  seed: 'bg-muted-foreground',
  probe: 'bg-[hsl(var(--tb-trace))]',
  chaos: 'bg-[hsl(var(--tb-fault))]',
  patch_staged: 'bg-[hsl(var(--tb-amber))]',
  rollout: 'bg-[hsl(var(--primary))]',
  restore: 'bg-foreground',
};

export function formatTimecode(us: number): string {
  const sign = us < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(us));
  const micro = abs % 1_000_000;
  const totalSec = Math.floor(abs / 1_000_000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(micro).padStart(6, '0')}`;
}

// Frames sit at their real microsecond timestamps along the time base, but a
// minimum spacing keeps bursts of frames individually grabbable.
function layout(frames: TimelineFrame[]): number[] {
  if (frames.length <= 1) return frames.map(() => 0.5);
  const t0 = frames[0]!.timestampUs;
  const span = Math.max(1, frames[frames.length - 1]!.timestampUs - t0);
  const raw = frames.map((f) => (f.timestampUs - t0) / span);
  const minGap = Math.min(0.03, 1 / (frames.length * 1.5));
  const out: number[] = [];
  raw.forEach((r, i) => out.push(i === 0 ? r : Math.max(r, out[i - 1]! + minGap)));
  const max = out[out.length - 1]!;
  return out.map((p) => (max > 1 ? p / max : p));
}

export function TemporalScrubber({ frames, activeSeq, onPreview, onCommit, onRestore }: Props): React.ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const tcRef = useRef<HTMLSpanElement | null>(null);
  const dragging = useRef(false);
  const lastSeq = useRef<number | null>(null);
  const positions = layout(frames);
  const t0 = frames[0]?.timestampUs ?? 0;
  const latest = frames[frames.length - 1]?.seq ?? null;
  const shownSeq = activeSeq ?? latest;
  const shownIndex = frames.findIndex((f) => f.seq === shownSeq);

  const placeHead = useCallback(
    (fraction: number, us: number): void => {
      const track = trackRef.current;
      const head = headRef.current;
      if (!track || !head) return;
      head.style.transform = `translate3d(${fraction * track.clientWidth}px, 0, 0)`;
      if (tcRef.current) tcRef.current.textContent = formatTimecode(us - t0);
    },
    [t0],
  );

  useEffect(() => {
    if (dragging.current || shownIndex < 0) return;
    placeHead(positions[shownIndex] ?? 0, frames[shownIndex]!.timestampUs);
  });

  const nearest = (clientX: number): { index: number; fraction: number } => {
    const rect = trackRef.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    let best = 0;
    positions.forEach((p, i) => {
      if (Math.abs(p - fraction) < Math.abs(positions[best]! - fraction)) best = i;
    });
    return { index: best, fraction };
  };

  const onMove = (clientX: number): void => {
    if (!frames.length) return;
    const { index, fraction } = nearest(clientX);
    const f0 = frames[0]!.timestampUs;
    const span = Math.max(1, frames[frames.length - 1]!.timestampUs - f0);
    placeHead(fraction, f0 + fraction * span);
    const seq = frames[index]!.seq;
    if (seq !== lastSeq.current) {
      lastSeq.current = seq;
      onPreview(seq);
    }
  };

  const step = (delta: number): void => {
    if (!frames.length) return;
    const i = Math.min(frames.length - 1, Math.max(0, (shownIndex < 0 ? frames.length - 1 : shownIndex) + delta));
    const seq = frames[i]!.seq;
    onPreview(seq);
    onCommit(seq === latest ? null : seq);
  };

  const current = shownIndex >= 0 ? frames[shownIndex] : undefined;

  return (
    <div className="px-4 pb-3 pt-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span ref={tcRef} className="tb-readout text-[15px] text-[hsl(var(--tb-trace))]">+00:00:00.000000</span>
        <span className="tb-readout text-[11px] text-muted-foreground">
          Frame {current?.seq ?? '—'} of {latest ?? '—'} · {current?.eventType.replace(/_/g, ' ').toLowerCase() ?? ''} · {current?.blastRadiusPct ?? 0}% blast
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{current?.summary}</span>
        {activeSeq !== null && activeSeq !== latest ? (
          <>
            <button type="button" onClick={() => current && onRestore(current.seq)} className="tb-readout flex items-center gap-1 text-[11px] text-[hsl(var(--tb-amber))] hover:underline">
              <IconRestore className="size-3.5" /> Restore as live
            </button>
            <button type="button" onClick={() => onCommit(null)} className="tb-readout flex items-center gap-1 text-[11px] text-[hsl(var(--tb-trace))] hover:underline">
              <IconPlayerTrackNext className="size-3.5" /> Live
            </button>
          </>
        ) : (
          <span className="tb-readout text-[11px] text-[hsl(var(--tb-trace))]">● Live</span>
        )}
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Incident timeline"
        aria-valuemin={frames[0]?.seq ?? 0}
        aria-valuemax={latest ?? 0}
        aria-valuenow={shownSeq ?? 0}
        className="relative h-10 cursor-ew-resize touch-none select-none rounded-md border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') step(-1);
          if (e.key === 'ArrowRight') step(1);
          if (e.key === 'End') onCommit(null);
        }}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          dragging.current = true;
          lastSeq.current = null;
          onMove(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && onMove(e.clientX)}
        onPointerUp={() => {
          dragging.current = false;
          const seq = lastSeq.current;
          if (seq !== null) onCommit(seq === latest ? null : seq);
        }}
      >
        {frames.map((f, i) => (
          <span
            key={f.seq}
            title={`#${f.seq} ${f.eventType}: ${f.summary}`}
            className={`absolute bottom-1 w-[3px] -translate-x-1/2 rounded-[1px] ${EVENT_TONE[f.eventType] ?? 'bg-muted-foreground'}`}
            style={{ left: `${(positions[i] ?? 0) * 100}%`, height: `${8 + Math.min(1, f.blastRadiusPct / 100) * 22}px`, opacity: f.seq === shownSeq ? 1 : 0.7 }}
          />
        ))}
        <div ref={headRef} className="pointer-events-none absolute inset-y-0 left-0 w-0" style={{ willChange: 'transform' }}>
          <div className="tb-glow absolute inset-y-0 -left-px w-[2px] bg-[hsl(var(--tb-trace))]" />
        </div>
      </div>
      <div className="tb-readout relative mt-1 h-3 text-[11px] text-muted-foreground">
        <span className="absolute left-0">{formatTimecode(0).slice(0, 9)}</span>
        {frames.length > 1 ? (
          <>
            <span className="absolute left-1/2 -translate-x-1/2">{formatTimecode((frames[frames.length - 1]!.timestampUs - t0) / 2).slice(0, 9)}</span>
            <span className="absolute right-0">{formatTimecode(frames[frames.length - 1]!.timestampUs - t0).slice(0, 9)}</span>
          </>
        ) : null}
      </div>
      <div className="mt-1 flex justify-end">
        <ul className="tb-readout flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Frame types">
          {Object.entries(EVENT_TONE).map(([type, tone]) => (
            <li key={type} className="flex items-center gap-1">
              <span className={`inline-block h-2 w-[3px] rounded-[1px] ${tone}`} />
              {type.replace(/_/g, ' ').toLowerCase()}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
