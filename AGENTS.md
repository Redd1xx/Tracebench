# TraceBench — Agent Guide

TraceBench is built on the chat-first agent-native starter. `/` redirects to shared sign-in, then `/home`, the editable Get started page. Chat lives at `/chat`; new chats start there. Actions carry capabilities; screens exist only for durable workflows.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

## TraceBench incident bench

Fault isolation on service meshes and PCB power boards. `/bench` lists benches; `/bench/:graphId?node=&frame=&gate=` is the workbench. `navigation` adds `graphId`, `selectedNodeId`, `activeFrameIndex` (absent = live), `openGateId`; tab state `bench-selection` adds `upstreamPath` and `downstreamBlastRadius`.

### Solver & Blast-Radius Gate Contract
- **Dependency direction (`u → v`):** Node `u` depends on node `v`. All telemetry propagation is computed by `app/lib/solver/` (`compute-blast-radius`): iterative Tarjan SCC condensation, effective latency (`L_eff`), cascading failure probability (`P_fail`), DC rail current/voltage drop (`ΔV = I·R`, `P = I²R`, current-limit foldback), and traffic-weighted blast radius.
- **15% Autonomous Rollout Cap:** `stage-patch` hashes the canonical patch JSON (SHA-256) and flags `requires_human_shield` whenever the computed blast radius exceeds `15%` or targets a `CRITICAL_TIER_1` node. Agents cannot self-countersign; calling `authorize-rollout` on a shielded gate from an agent/CLI/MCP/A2A caller throws `BLAST_RADIUS_CAP_EXCEEDED` (409).Patches within the 15% cap on non-tier-1 nodes can be rolled out autonomously.
- **Immutable Timeline & Probes:** Record observations via `log-probe` (`recordedBy: "agent_probe"`), simulate faults with `inject-fault`, and scrub or restore frames with `seek-frame`.
- **Runbooks & Browser Tools:** Check `.agents/skills/incident-runbooks/SKILL.md` (`learnedRules` in `get-graph-state`) before staging patches; `metabolize-runbook` captures operator edits into the runbook. When a bench tab is open, `window.__agentNativeWebMcp` provides `select-schematic-node` and `dry-run-patch` (in-browser solver preview without staging). For rich chat summaries, use `render-inline-extension` (affected subgraph table) or `save-data-program` (`appAction("list-graphs")`).
