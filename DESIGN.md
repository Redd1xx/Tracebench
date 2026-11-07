---
contract: TraceBench visual design
revision: 1
---

# TraceBench — Design Contract

TraceBench is an instrument, not a website. It should feel like a bench
oscilloscope wired to a logic analyzer: a dark phosphor field, traces that
glow only where signal exists, and a time base you can grab and scrub.

## 1. Product mode and audience

| Decision | Choice |
| --- | --- |
| Product mode | `operate` |
| Audience | SREs and hardware bring-up engineers mid-incident; long sessions, high stakes, constant context switching between graph, readings and time |
| Primary job | Find the root fault, probe it, stage the smallest safe patch, and get a human countersign when the blast radius demands it |

## 2. Visual world: "Phosphor Bench"

- **Ground:** near-black with a green-cyan undertone (`--tb-ground`), like a
  CRT with the beam off. A faint 10-division graticule sits behind the
  schematic.
- **Signal:** phosphor teal (`--tb-trace`) is the only bright hue at rest —
  healthy links and the playhead. Pine/teal is the palette family.
- **Alarm:** amber (`--tb-amber`) for degraded, hot coral (`--tb-fault`) for
  fault. Isolated nodes go hollow and dim. Blast radius is drawn as a coral
  halo whose opacity is the solver's coupling strength.
- **Shield:** the Shielded Gate uses a hazard double-border in amber; nothing
  else in the app uses that treatment.
- **Light theme:** "service manual" — pale green-grey paper with dark teal ink;
  same semantics, lower glow.

## 3. Type

- `IBM Plex Serif` for headings and node labels.
- `Space Mono` for every reading, timecode, hash, and key. Readouts are
  uppercase units (`V`, `MS`, `A`, `%`) with tabular alignment.
- `Inter` for body copy: a compact technical grotesk that stays legible in
  dense panels.

## 4. Composition

```
┌───────────────────────────────────────────────────────┬──────────────┐
│ header: bench name · solver readout strip             │              │
├───────────────────────────────────────────────────────┤  Inspector   │
│                                                       │  (node / gate│
│   schematic canvas (pan/zoom, probe pills on nodes)   │   / probes)  │
│                                                       │              │
├───────────────────────────────────────────────────────┴──────────────┤
│ temporal scrubber: frame ticks on a µs time base · playhead · TC     │
└──────────────────────────────────────────────────────────────────────┘
```

- The scrubber is always docked at the bottom; scrubbing previews history
  locally at 60fps and commits `seek-frame` on release.
- When a historical frame is shown, the whole canvas gets an amber "REPLAY"
  frame so nobody mistakes the past for live state.

## 5. Shape and motion

- Square-ish 3px corners on panels, pill-shaped probe tags anchored by a
  leader line. Links are orthogonal-ish cubic curves with arrowheads.
- Motion only carries meaning: playhead and timecode update through refs and
  `translate3d`; blast halos fade in over 150 ms; everything respects
  `prefers-reduced-motion`.

## 6. Anti-references

- No purple/blue AI gradients, mesh blobs, particles or glassmorphism.
- No card grids of KPIs; numbers live on the instrument where they belong.
- No sparkle/wand/robot icons. Agent hand-off is "Ask agent" with
  `IconMessageForward`.

## 7. States

- Loading: skeleton graticule with node-sized blocks and an empty time base.
- Empty bench list: single action to open a starter incident (seeded).
- Errors: toasts with `actionErrorMessage`; `BLAST_RADIUS_CAP_EXCEEDED` is
  shown inline on the gate as "Shield required".
