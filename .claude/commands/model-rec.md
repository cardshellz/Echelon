---
description: Recommend the best Claude model + reasoning effort for a task in this repo
argument-hint: <task description>
---

Recommend which Claude model and reasoning-effort level to run for this task:

<task>$ARGUMENTS</task>

If no task was given, infer the task from the current conversation context and
say what you inferred.

Score the task against this repo's risk rubric. Echelon is a financial system
(CLAUDE.md: assume bugs cause financial loss; correctness > speed > cleverness).
If ANY part of the task lands in Tier 1, the whole task is Tier 1.

**Tier 1 — top available model (Fable if offered, else Opus), effort high, fast mode OFF:**
- Anything that can alter financial state: inventory levels, reservations,
  picks/ships, order or refund state, ledger tables, money columns
- Concurrency, idempotency, transactions, advisory locks, webhook/event processing
- Cross-system flows (channels ↔ OMS ↔ WMS ↔ shipping engine), writer-topology
  or single-writer-ownership changes
- Schema migrations and data-repair scripts (they touch production data)
- Root-cause debugging of production incidents

**Tier 2 — Opus, effort medium→high, fast mode acceptable:**
- Single-module features with no financial-state writes
- Refactors fully protected by the green suite + writer ratchet
- Writing tests for existing behavior; read-only analysis or reporting

**Tier 3 — Sonnet (or Opus fast mode), effort low→medium:**
- Mechanical edits: renames, comments, docs, config, UI copy
- Running scripts/test suites and summarizing output

Answer in exactly this shape, nothing more:
- **Model**: <model>
- **Effort**: <low | medium | high | max>
- **Fast mode**: <ok | avoid>
- **Why**: one sentence naming the rubric line that matched
