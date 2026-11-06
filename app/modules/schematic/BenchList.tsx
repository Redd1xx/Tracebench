import { useActionQuery } from '@agent-native/core/client/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconChartDonut3,
  IconCircleX,
  IconCpu,
  IconShieldLock,
  IconTopologyStar3,
} from '@tabler/icons-react';
import { AgentToggleButton } from '@agent-native/toolkit/app/chat';
import { Link } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { ReinitializeBenchDialog } from '@/modules/shell/ReinitializeBenchDialog';
import { ScopeEmblem } from '@/modules/shell/ScopeEmblem';

type Graph = AgentNativeActionRegistry['list-graphs']['result']['graphs'][number];

// Each bench gets its own tinted section, the way a long product page changes key between chapters.
const TINTS = [
  { panel: 'bg-[hsl(222_26%_14%)] border-[hsl(222_22%_22%)]', icon: 'text-[hsl(150_45%_62%)]', glow: 'hsl(150 45% 45% / 0.22)' },
  { panel: 'bg-[hsl(258_20%_12%)] border-[hsl(258_16%_20%)]', icon: 'text-[hsl(26_80%_64%)]', glow: 'hsl(26 80% 55% / 0.24)' },
] as const;

// A faint constellation over the hero: services as stars, their dependencies as lines.
const STARS: [number, number][] = [
  [8, 22], [17, 12], [27, 30], [36, 16], [44, 34], [57, 14], [66, 28], [75, 10], [83, 24], [92, 15],
  [12, 48], [31, 52], [50, 44], [70, 50], [88, 42],
];
const LINKS: [number, number][] = [[1, 3], [3, 5], [5, 7], [3, 4], [4, 12], [12, 13], [7, 8], [8, 14]];

function Constellation(): React.ReactElement {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 60" preserveAspectRatio="none">
      {LINKS.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={STARS[a]![0]} y1={STARS[a]![1]} x2={STARS[b]![0]} y2={STARS[b]![1]} stroke="white" strokeOpacity="0.09" strokeWidth="0.08" />
      ))}
      {STARS.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 4 === 0 ? 0.32 : 0.18} fill="white" fillOpacity={i % 3 === 0 ? 0.7 : 0.4} />
      ))}
    </svg>
  );
}

function Hills(): React.ReactElement {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full" viewBox="0 0 1440 160" preserveAspectRatio="none">
      <path d="M0 110 C 180 70 320 96 480 80 C 660 62 820 104 1000 86 C 1180 68 1320 92 1440 78 L1440 160 L0 160Z" fill="hsl(268 26% 20%)" />
      <path d="M0 132 C 220 104 420 126 640 114 C 860 102 1060 132 1260 118 C 1350 112 1400 116 1440 120 L1440 160 L0 160Z" fill="hsl(255 26% 13%)" />
    </svg>
  );
}

function Preview({ g, glow }: { g: Graph; glow: string }): React.ReactElement {
  const failing = g.faultCount > 0;
  return (
    <div className="relative">
      <div aria-hidden="true" className="absolute -inset-6 rounded-[28px] blur-2xl" style={{ background: `radial-gradient(60% 60% at 50% 85%, ${glow}, transparent 70%)` }} />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[hsl(250_20%_6%)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-[13px]">
          <span className="text-white/50">benches</span>
          <span className="text-white/30">/</span>
          <span className="truncate text-white/90">{g.name}</span>
        </div>
        <div className="relative grid h-64 place-items-center" style={{ backgroundImage: 'radial-gradient(hsl(250 30% 80% / 0.12) 1px, transparent 1.3px)', backgroundSize: '18px 18px' }}>
          <div className="w-60 rounded-xl border border-white/10 bg-[hsl(255_14%_15%)] p-4 shadow-xl">
            <div className="flex items-center gap-2.5">
              {g.domainMode === 'hardware_pcb' ? <IconCpu className="size-5 text-white/60" /> : <IconTopologyStar3 className="size-5 text-white/60" />}
              <span className="text-[15px] font-semibold text-white">{g.domainMode === 'hardware_pcb' ? 'Power rails' : 'Service mesh'}</span>
            </div>
            <div className={`mt-6 flex items-center gap-1.5 text-[13px] ${failing ? 'text-[hsl(0_84%_66%)]' : 'text-[hsl(148_60%_55%)]'}`}>
              {failing ? <IconCircleX className="size-4" /> : null}
              {failing ? `Failing · ${g.blastRadiusPct ?? 0}% of traffic hit` : 'All services healthy'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BenchList(): React.ReactElement {
  const { data, isPending } = useActionQuery('list-graphs', {});
  const first = data?.graphs.find((g) => g.domainMode !== 'hardware_pcb') ?? data?.graphs[0];

  return (
    <main className="min-h-full bg-[hsl(249_24%_9%)] p-2 text-white">
      {/* Top bar: the product name left, the two places you can go, the agent on the right. */}
      <nav aria-label="TraceBench" className="flex h-14 items-center gap-6 px-4">
        <Link to="/bench" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <ScopeEmblem />
          TraceBench
        </Link>
        <div className="ml-auto flex items-center gap-1 text-[14px] text-white/75">
          <a href="#benches" className="rounded-md px-3 py-1.5 hover:bg-white/5 hover:text-white">Benches</a>
          <Link to="/chat" className="rounded-md px-3 py-1.5 hover:bg-white/5 hover:text-white">Chat</Link>
          <ReinitializeBenchDialog className="rounded-md px-3 py-1.5 hover:bg-white/5 hover:text-white max-sm:hidden" />
          <AgentToggleButton />
        </div>
      </nav>
      {/* Hero: a night sky over quiet hills, the headline set in a serif. */}
      <section className="tb-sky relative overflow-hidden rounded-2xl border border-white/10 px-6 pb-48 pt-24 text-center sm:pt-28">
        <Constellation />
        <Hills />
        <div className="relative mx-auto max-w-3xl">
          <h1 className="tb-serif text-4xl sm:text-[54px]">
            Fix incidents
            <br />
            without the blast radius
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-white/70">
            The agent rolls out patches up to a 15% blast cap. Anything bigger waits for your countersignature.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {first ? (
              <Link
                to={`/bench/${first.id}`}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-[hsl(259_35%_38%)] px-5 text-[15px] font-medium text-white shadow-lg transition-colors hover:bg-[hsl(259_35%_44%)]"
              >
                Open {first.name} <IconArrowRight className="size-4" />
              </Link>
            ) : null}
            <a
              href="#benches"
              className="inline-flex h-11 items-center rounded-lg border border-white/15 bg-black/30 px-5 text-[15px] font-medium text-white backdrop-blur transition-colors hover:bg-black/40"
            >
              All benches
            </a>
          </div>
        </div>
      </section>

      {/* On-call incident drill sequence. */}
      {first ? (
        <section aria-labelledby="tour" className="mt-2 rounded-2xl border border-white/10 bg-[hsl(250_20%_7%)] px-6 py-10 sm:px-10 lg:px-20">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="tour" className="tb-serif text-2xl text-white sm:text-[28px]">On-call incident drill</h2>
            <p className="text-[14px] text-white/55">Checkout Mesh is live with an active pool saturation fault.</p>
          </div>
          <ol className="mt-6 grid gap-3 md:grid-cols-3">
            {[
              { n: 1, title: 'Open the checkout mesh', body: 'payments-db is saturated and 83% of traffic is hit. Every number comes from the solver.' },
              { n: 2, title: 'Press Ask agent', body: 'It ranks the root cause and stages the smallest patch. Anything over 15% of traffic is blocked at the gate.' },
              { n: 3, title: 'Countersign at the gate', body: "Edit the agent's patch, sign it, then metabolize your edit into the runbook it reads next time." },
            ].map((step) => (
              <li key={step.n}>
                <Link
                  to={`/bench/${first.id}`}
                  className="group flex h-full flex-col rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-[hsl(259_45%_62%)] hover:bg-white/[0.05]"
                >
                  <span className="grid size-7 place-items-center rounded-full bg-[hsl(259_35%_38%)] text-[13px] font-semibold text-white">{step.n}</span>
                  <span className="mt-4 text-[16px] font-medium text-white">{step.title}</span>
                  <span className="mt-1.5 text-[14px] leading-relaxed text-white/60">{step.body}</span>
                  {step.n === 1 ? (
                    <span className="mt-4 inline-flex items-center gap-1 text-[14px] font-medium text-[hsl(259_60%_78%)]">
                      Start here <IconArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* One chapter per bench, threaded by a rail like stops on a line. */}
      <div id="benches" className="relative">
        {isPending
          ? [0, 1].map((i) => <Skeleton key={i} className="mt-2 h-[420px] rounded-2xl" />)
          : data?.graphs.map((g, i) => {
              const tint = TINTS[i % TINTS.length]!;
              const rows = [
                { Icon: IconChartDonut3, title: `${g.blastRadiusPct ?? 0}% of traffic hit`, body: 'Blast radius of the faults on the board right now.' },
                {
                  Icon: g.faultCount ? IconAlertTriangle : IconShieldLock,
                  title: g.faultCount ? `${g.faultCount} failing ${g.faultCount === 1 ? 'node' : 'nodes'} of ${g.nodeCount}` : `${g.nodeCount} nodes, all healthy`,
                  body: g.domainMode === 'hardware_pcb' ? 'Rails solved by nodal analysis, I·R drop on every trace.' : 'Dependencies solved upstream and downstream from each fault.',
                },
                {
                  Icon: IconShieldLock,
                  title: `Agent cap ${g.agentBlastCapPct}%`,
                  body: g.pendingGates ? `${g.pendingGates} gate waiting on your countersignature.` : 'Bigger patches wait for your countersignature.',
                },
              ];
              return (
                <section key={g.id} className={`relative mt-2 overflow-hidden rounded-2xl border px-6 py-16 sm:px-10 lg:px-20 ${tint.panel}`}>
                  <div aria-hidden="true" className="absolute bottom-0 left-10 top-0 hidden w-px bg-white/10 lg:block" />
                  <div aria-hidden="true" className="absolute left-[34px] top-[72px] hidden size-3 rounded-full border border-white/40 bg-[hsl(249_24%_9%)] lg:block" />
                  <div className="grid items-center gap-12 lg:grid-cols-2 lg:pl-10">
                    <div>
                      <span className="inline-flex rounded-md bg-white/[0.08] px-2.5 py-1 text-[13px] text-white/80">
                        {g.domainMode === 'hardware_pcb' ? 'PCB power board' : 'Service mesh'}
                      </span>
                      <h2 className="tb-serif mt-5 text-3xl text-white sm:text-[36px]">{g.name}</h2>
                      <p className="mt-4 max-w-md text-[16px] leading-relaxed text-white/65">
                        {g.nodeCount} {g.domainMode === 'hardware_pcb' ? 'parts' : 'services'} on the bench, {g.frameCount} {g.frameCount === 1 ? 'frame' : 'frames'} on the timeline.{' '}
                        <Link to={`/bench/${g.id}`} className="inline-flex items-center gap-1 font-medium text-white hover:underline">
                          Open bench <IconArrowRight className="size-4" />
                        </Link>
                      </p>
                      <ul className="mt-8 divide-y divide-white/10 border-t border-white/10">
                        {rows.map(({ Icon, title, body }) => (
                          <li key={title} className="flex gap-4 py-4">
                            <Icon className={`mt-0.5 size-5 shrink-0 ${tint.icon}`} />
                            <div>
                              <p className="text-[15px] text-white">{title}</p>
                              <p className="text-[14px] text-white/55">{body}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Preview g={g} glow={tint.glow} />
                  </div>
                </section>
              );
            })}
      </div>
    </main>
  );
}
