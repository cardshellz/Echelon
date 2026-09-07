# Automatic receipt-cost recovery

The worker retries existing durable receipt-cost requests after a committed physical receipt. It calls `ReceivingService.retryCostsAutomatically`, which delegates to `processReceiptCostRequests` and the same approved-invoice cost owner used by explicit receipt retries. It does not receive stock, send purchases, classify unknown amounts, or replace the financial owner.

`receipt-cost-recovery.domain.ts` defines five automatic attempts with bounded backoff. New requests have a two-minute grace period so normal close processing can finish first. `receipt-cost-recovery.repository.ts` claims one request at a time with a five-minute lease and row locks, fences stale completions, and records immutable before/after events. Applied and review-required cost outcomes stop automatic retry. Exhaustion retains the explicit manual retry button.

The immutable cost request and financial attempt remain authoritative. A crash after the cost transaction commits is recovered from that attempt without applying costs again. A failure recording the job audit rolls back scheduling changes. Financial rollback never erases the physical receipt.

## Runtime setup

Migration `231_receipt_cost_recovery.sql` must precede the new code. The standard SQL release runner discovers it automatically. Enable the worker with `RECEIPT_COST_RECOVERY_ENABLED=true`; `DISABLE_SCHEDULERS=true` and `RECEIPT_COST_RECOVERY_DISABLED=true` stop it. This development work does not change live settings. The worker polls every minute and processes at most five requests per batch. Its server-close handler stops future polling; leases cover interrupted work.

The purchase workspace shows the automatic attempt budget, next scheduled attempt, failure code, and exhaustion alongside the existing immutable financial attempts. A later verified manual completion supersedes stale scheduling text. Review-required evidence requires an operator to resolve it before explicitly retrying costs.

## Verification

Focused unit tests cover finite retries, invalid/cross-request/unrecorded responses, clocks, shutdown gates, lost leases and display semantics. Real PostgreSQL owner tests cover AP audit rollback with preserved stock, manual/background concurrency, competing claimants, lease expiry, crash recovery, exhaustion, a review arriving after claim, and claim-audit rollback. Workspace PostgreSQL tests read actual scheduling JSON. The desktop/mobile browser journey displays queued and exhausted recovery within the purchase lifecycle.

Production historical-cost completeness and workload throughput are operational validation tasks; synthetic tests do not certify them.
