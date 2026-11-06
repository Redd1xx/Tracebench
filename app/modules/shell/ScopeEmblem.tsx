import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

export function ScopeEmblem(props: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn('size-6 shrink-0', props.className)}
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="3"
        fill="hsl(var(--tb-ground))"
        stroke="hsl(var(--tb-trace) / 0.6)"
        strokeWidth="1"
      />
      <path
        d="M1 12h22M12 1v22"
        stroke="hsl(var(--tb-graticule) / 0.25)"
        strokeWidth="0.6"
      />
      <path
        d="M3 14h4l2-6 2.5 10L14 6l2 8h5"
        fill="none"
        stroke="hsl(var(--tb-trace))"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="14" cy="6" r="1.4" fill="hsl(var(--tb-fault))" />
    </svg>
  );
}

export function ScopeTitle(props: { className?: string }): ReactElement {
  return (
    <span
      className={cn(
        'tb-head truncate text-[15px] font-bold uppercase leading-none tracking-[0.08em] text-sidebar-accent-foreground',
        props.className,
      )}
    >
      Trace<span className="text-[hsl(var(--tb-trace))]">Bench</span>
    </span>
  );
}
