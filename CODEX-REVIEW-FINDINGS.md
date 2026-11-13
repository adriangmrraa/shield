# Shield order reconciliation — static review

Scope: one static pass; no tests, builds, installation, provider calls, or source changes. Line references are to the reviewed worktree.

## Findings

### HIGH — Polling can requeue an in-flight POST and cause duplicate dispatch

`src/server/shield/providerDispatcher.ts:165-167,182-186`; `src/server/shield/statusTracker.ts:133-157,209-215`; `src/server/shield/persistence/jsonOrderRepository.ts:44-49`.

The dispatcher saves `enviada` **before** starting the POST. While that POST is in flight (or even before it starts), the independently running tracker can list the provider before the provider records the order, interpret its absence as a 404, and save it back as `pendiente_envio`. A subsequent dispatch cycle can POST the same `orden_id` again. The first POST's eventual 202 also writes a stale full record as `recibida`; it can overwrite a newer `aplicada` or `fallida` observed by the tracker. Conversely, a delayed missing-order poll can overwrite the 202's `recibida` with `pendiente_envio` after acceptance. Serialized file writes do not implement conditional state transitions. A 409 may later adopt remote truth, but does not prevent the duplicate POST, and adoption itself can fail (`providerDispatcher.ts:212-233`).

The normal timer loops await their own cycles (`providerDispatcher.ts:294-322`, `statusTracker.ts:417-445`), but there is no cross-service lock or in-flight check; `cycleOnce` is also public and unguarded. A stop/start while a cycle is in flight can start another loop. The same race exists on the fallback per-order 404 path (`statusTracker.ts:191-202`).

### HIGH — Provider 5xx responses are persisted as definitive rejection

`src/server/shield/qualydataClient.ts:44-54,191-197`; `src/server/shield/providerDispatcher.ts:194-208,236-241`; `src/server/shield/statusTracker.ts:133-135`.

If a POST receives HTTP 500/502/503, including after an upstream accepted it but a gateway failed, the client represents it as `SimulatorHttpError`. The dispatcher handles every such status except 409 as `rechazada_proveedor` with `final=true`, although the comments describe only contract 4xx as definitive. The tracker never polls this state, so a live or applied provider order is abandoned locally; a transient outage also permanently prevents an otherwise valid order from being sent.

### HIGH — Failed-only cases never become terminal

`src/server/shield/statusTracker.ts:365-382,470-485,507-523`; `src/server/shield/expedienteTypes.ts:25-35`.

When every latest slot is terminal failure (for example provider rejection, exhausted `fallida`, or local expiry hold), `aggregateTarget` explicitly returns `null`. Every later cycle therefore leaves the case `aprobado` or `distribuyendo` indefinitely. The current case graph lacks a failure terminal edge, so this needs an explicit domain/graph decision rather than pretending the order was applied or expired. Zero-order approved cases also return `null` (`statusTracker.ts:507-508`).

### HIGH — Approval can survive a crash without all of its orders

`src/server/shield/orderService.ts:126-160,211-216`; `src/server/shield/statusTracker.ts:365-376,507-510`.

Approval persists the case transition before composing and individually saving orders. A crash or audit failure after the transition and before the first or a later order save leaves an approved case with zero or only a subset of its intended orders. Repeating approval is rejected because the case is no longer `pendiente_juez`; the tracker only aggregates orders that exist, and cannot reconstruct missing slots. Zero orders leave the case open forever; a partial set can falsely drive the case to a later state without distributing all approved measures.

### MEDIUM — One invalid batch row stalls every order at that provider

`src/server/shield/qualydataClient.ts:91-103,160-170`; `src/server/shield/statusTracker.ts:145-163,164-165`; `src/server/shield/types.ts:146-169`.

If one provider-list row has an unknown state or another schema-invalid field, parsing the entire array fails and the batch catch skips **all** local orders at that provider for the cycle. If that row persists, otherwise valid `enviada`/`recibida` orders remain stuck and applied/expired transitions are not adopted. In the fallback path each individual response is parsed and caught separately, so a bad row affects only its own order. Ordinary absent rows are not silently dropped: the batch explicitly passes `null` to the same missing-order handler as a per-order 404 (`statusTracker.ts:154-157,191-215`).

### MEDIUM — Retry can be signed against a different match's clock

`src/server/shield/statusTracker.ts:129-132,289-339`; `src/server/shield/types.ts:6-12`; `src/server/shield/expedienteTypes.ts:95-99`; `src/server/shield/signingService.ts:131-146`.

A failed order surviving a match change is retried using the current `/estado` minute, current shift, and current `fin_min` without checking the originating expediente's `partido_id` against `estado.partido`. If the new match is active and the old judge is on shift, the retry is signed for the old case/target with the new match's expiry. The retry draft reuses the original case, type, target, court and judge, but replaces `orden_id` and `vence_min`; the HMAC covers `orden_id|tipo|objetivo|vence_min|juez_id`, not match or case identity. This requires a match change while a non-final failure remains, for example across downtime.

## State and transition audit

- Local states: `pendiente_envio`, `enviada`, `recibida`, `aplicada`, `fallida`, `vencida`, `levantada`, `rechazada_proveedor`, `bloqueada_turno` (`judicialTypes.ts:38-54`). `pendiente_envio` can also be terminal via `final=true`; `fallida` is retryable until final (`statusTracker.ts:470-485`).
- Composition creates `pendiente_envio`; dispatch moves it to `enviada`, local terminal hold, `bloqueada_turno`, or rejection; a 202 moves `enviada` to `recibida`. Missing remote `enviada` moves back to `pendiente_envio`; 409 adopts remote truth. Polling `enviada`, `recibida`, or `aplicada` directly adopts any provider state (`providerDispatcher.ts:130-167,182-218,236-259`; `statusTracker.ts:133-135,191-251`).
- Provider states are `recibida`, `aplicada`, `fallida`, `vencida`, `levantada`; `applyProviderView` copies the reported state directly (`types.ts:146-152`; `judicialTypes.ts:105-115`). A non-final latest `fallida` produces a newly signed pending attempt or becomes final on max attempts, match end, or off-shift judge (`statusTracker.ts:168-177,289-346`). Terminal provider states are not polled again.
- State misclassification: checked, no defect in the direct provider-state mapping; a 202 alone becomes `recibida`, not `aplicada`. Stale concurrent saves can nevertheless regress an already observed state as described above.
- Batch ID mapping: checked for valid complete responses; rows are scoped by provider then keyed by `orden_id`, and missing IDs share the fallback 404 handling. The in-flight absence race and whole-array validation regression are findings above.
- Retry after confirmed `aplicada`, `vencida`, or definitive rejection: checked, no direct retry edge; only latest non-final `fallida` is retried. The stale-save race and cross-match context finding qualify this conclusion.
- Crash after provider acceptance: checked; the pre-POST `enviada` write permits provider truth to be adopted after restart, provided the remote remains queryable. It does not prevent the in-flight race above.
