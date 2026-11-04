---
name: incident-runbooks
description: >-
  Remediation rules learned when operators hand-edited agent patches before
  approving them in TraceBench's Shielded Gate. Read before stage-patch.
scope: both
---

# Incident Runbooks

Each rule comes from a real diff between `agent_proposed_patch` and the
operator's `operator_final_patch`, written by `metabolize-runbook`.

No rules below this line means none have been learned yet: draft from first principles.
