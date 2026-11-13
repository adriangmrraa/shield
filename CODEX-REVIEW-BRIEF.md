# Codex Review Brief — Shield Order Reconciliation State Machine

You are an independent reviewer for the Perioshield judicial blocking stack.
This worktree is `review/order-recon-codex` based at cce277a (the audit branch
head — it already contains one repair: `statusTracker.runCycle` now polls the
provider order LIST in batch instead of one GET per order).

Scope is ONE bounded question. Do not wander into auth, routes, sockets, or UI.

## The question

In the order lifecycle — `src/server/shield/providerDispatcher.ts`,
`src/server/shield/statusTracker.ts`, `src/server/shield/orderService.ts`,
with `src/server/shield/signingService.ts` (retry signing) and
`src/server/shield/persistence/` (store ops) read as needed —
can ANY interleaving of dispatch cycles, poll cycles, retries, provider
responses, or process restarts produce one of:

1. **Duplicate provider POST** — same orden_id re-sent, or a semantically
   duplicate retry emitted while the provider still holds a live original.
2. **Permanently stuck order** — `pendiente_envio` or `enviada` forever,
   e.g. crash between provider 202-accept and persistence of the transition,
   or a requeue path that never fires.
3. **Incorrect retry** — retry emitted for an order the provider applied,
   expired, or definitively rejected; or a retry signed without valid
   shift/match context (check exactly which fields `orderService` re-signs).
4. **Expediente stuck non-terminal** — a case left in an open state when all
   its orders reached terminal states.
5. **Batch-path regression** — the new `ordenes()` list call in
   `runCycle` mis-mapping provider rows to local orders, silently dropping a
   missing order versus the old per-order 404 handling, or any semantics
   difference versus the fallback path (`orden()` per-order).
6. **State misclassification** — `recibida` treated as `aplicada`, or any
   provider state string mapped to the wrong local state.

## Method

- Pure static review. `node_modules` is NOT installed here and must not be.
- Enumerate the order states and every transition edge; test each edge
  against: crash before persistence, concurrent/overlapping cycles (is there
  a dispatch/poll lock? check `start()`, timers, in-flight guards), provider
  409, provider outage windows, provider state adoption.
- For each finding: `file:line`, the exact interleaving, the consequence.
- For each category with no defect: one line "checked, no defect".

## Hard constraints

- READ-ONLY by default. A minimal fix is allowed ONLY for a clear critical
  security/correctness defect, on its own commit with explicit paths
  (conventional commit, e.g. `fix(shield): ...`; never `git add -A`).
- Do NOT run npm install, tests, builds, or any test suite.
- No push, merge, deploy, DB migrations, file or worktree deletion, and no
  external network calls of any kind (the simulator and provider endpoints
  are NOT part of this review).
- Exactly one focused pass. When done, write findings to
  `CODEX-REVIEW-FINDINGS.md` at the repo root and stop.

Severity labels: CRITICAL / HIGH / MEDIUM / LOW. Prefer few verified
findings over many speculative ones — every claim needs file:line evidence.
