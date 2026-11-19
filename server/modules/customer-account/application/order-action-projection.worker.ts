import { customerOrderActionSnapshotSchema } from "@shared/customer-account/order-actions";
import { orderActionScopeSchema, type OrderActionProjectionStore, type OrderActionProjectionInspector } from "./order-action-projection.ports";
import { canDeferClosedRefresh } from "../domain/order-action-refresh";

const CONCURRENCY = 2;
const ACTIVE_REFRESH_MS = 60_000;
const RETURN_REFRESH_MS = 5 * 60_000;
const CLOSED_REFRESH_MS = 24 * 60 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;
// A refresh deadline is not a permission deadline. These are navigation/display
// facts; every command still uses the existing fresh owners. Local source changes
// invalidate immediately, and time-bound return eligibility expires at its window.
const MAX_PRESENTATION_AGE_MS = 24 * 60 * 60_000;
const CLOSED_CANDIDATE_LIMIT = 50;

/** All slow provider inspection belongs here, never in account display reads.
 * A lease and generation compare prevent duplicate workers or a late inspection
 * from publishing evidence superseded by a local lifecycle change. */
export class OrderActionProjectionWorker {
  constructor(private readonly dependencies: {
    store: OrderActionProjectionStore;
    inspector: OrderActionProjectionInspector;
    now(): Date;
    newId(): string;
    report(event: { action: string; outcome: string; omsOrderId?: number; code?: string; durationMs?: number }): void;
  }) {}

  async run(): Promise<void> {
    const { store, inspector, now, report } = this.dependencies;
    await store.drainInvalidations(1_000);
    await store.seed(200);
    // Classify existing scheduled evidence locally before claiming provider
    // work. The repository fences customer demand, source changes and leases.
    const candidates = await store.scheduledCandidates(CLOSED_CANDIDATE_LIMIT, now());
    const closed = candidates.filter(candidate => {
      const parsed = customerOrderActionSnapshotSchema.safeParse(candidate.snapshot);
      return parsed.success && canDeferClosedRefresh(parsed.data);
    });
    if (closed.length) await store.deferClosed(closed, now());
    // Do not lease work that will sit behind a slow provider call in this process.
    const scopes = await store.claim(CONCURRENCY, now(), this.dependencies.newId());
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scopes.length) }, async () => {
      while (next < scopes.length) {
        const scope = orderActionScopeSchema.parse(scopes[next++]);
        const started = now().getTime();
        try {
          const { failureClass, ...evidence } = await inspector.inspect(scope);
          const snapshot = customerOrderActionSnapshotSchema.parse(evidence);
          const instant = now();
          let refreshMs = snapshot.orderFailed || snapshot.returnFailed ? Math.min(MAX_RETRY_MS, ACTIVE_REFRESH_MS * 2 ** Math.min(scope.attempts, 5))
            : snapshot.order?.activeOperationId || snapshot.order?.activeOperationKind || snapshot.order?.activeOperationStatus || snapshot.order?.eligibility.editable
              || snapshot.order?.addressEligibility?.editable || snapshot.order?.cancellation?.canReview
              || snapshot.order?.cancellation?.requestKey ? ACTIVE_REFRESH_MS
              : snapshot.returnOrder?.order.lines.some(line => line.eligibleQuantity > 0) ? RETURN_REFRESH_MS : CLOSED_REFRESH_MS;
          const windowEnd = snapshot.returnOrder?.order.returnWindowEndsAt;
          let validMs = MAX_PRESENTATION_AGE_MS;
          if (windowEnd && Date.parse(windowEnd) > instant.getTime())
            validMs = Math.min(validMs, Date.parse(windowEnd) - instant.getTime());
          refreshMs = Math.min(refreshMs, validMs);
          const validUntil = new Date(instant.getTime() + validMs);
          const refreshAt = canDeferClosedRefresh(snapshot) ? null : new Date(instant.getTime() + refreshMs);
          const published = await store.complete(scope, snapshot, instant, validUntil, failureClass, refreshAt);
          const partialFailure = snapshot.orderFailed || snapshot.returnFailed;
          report({ action: "order_action_projection", outcome: partialFailure ? "failed" : published ? "published" : "superseded",
            ...(partialFailure ? { code: "ORDER_ACTION_PARTIAL_INSPECTION_FAILED" } : {}), omsOrderId: scope.omsOrderId,
            durationMs: instant.getTime() - started });
        } catch {
          const instant = now();
          const retryMs = Math.min(MAX_RETRY_MS, ACTIVE_REFRESH_MS * 2 ** Math.min(scope.attempts, 5));
          await store.fail(scope, instant, new Date(instant.getTime() + retryMs), "ORDER_ACTION_INSPECTION_FAILED");
          report({ action: "order_action_projection", outcome: "failed", omsOrderId: scope.omsOrderId, code: "ORDER_ACTION_INSPECTION_FAILED" });
        }
      }
    }));
  }
}
