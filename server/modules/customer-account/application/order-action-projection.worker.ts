import { customerOrderActionSnapshotSchema } from "@shared/customer-account/order-actions";
import { orderActionScopeSchema, type OrderActionProjectionStore, type OrderActionProjectionInspector } from "./order-action-projection.ports";

const CONCURRENCY = 2;
const ACTIVE_REFRESH_MS = 60_000;
const RETURN_REFRESH_MS = 5 * 60_000;
const CLOSED_REFRESH_MS = 24 * 60 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;

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
            : snapshot.order?.activeOperationId || snapshot.order?.eligibility.editable ? ACTIVE_REFRESH_MS
              : snapshot.returnOrder?.order.lines.some(line => line.eligibleQuantity > 0) ? RETURN_REFRESH_MS : CLOSED_REFRESH_MS;
          const windowEnd = snapshot.returnOrder?.order.returnWindowEndsAt;
          if (windowEnd && Date.parse(windowEnd) > instant.getTime())
            refreshMs = Math.min(refreshMs, Date.parse(windowEnd) - instant.getTime());
          const validUntil = new Date(instant.getTime() + refreshMs);
          const published = failureClass ? await store.complete(scope, snapshot, instant, validUntil, failureClass)
            : await store.complete(scope, snapshot, instant, validUntil);
          report({ action: "order_action_projection", outcome: published ? "published" : "superseded", omsOrderId: scope.omsOrderId,
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
