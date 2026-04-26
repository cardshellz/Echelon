/**
 * server/instrumentation/metrics.ts
 *
 * Lightweight observability counters for the SHIP/WMS/OMS failure
 * surfaces called out in shipstation-sync-audit.md §7.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 36.
 *
 * Approach (Decision option C):
 *   Structure-log emit instead of pulling in `prom-client`. Each
 *   `incr()` call emits a single line of the form:
 *     metric=<name> count=<n> [k1=v1 k2=v2 ...]
 *   Existing log drains can aggregate; future migration to a real
 *   Prometheus client is one file change away (this module's
 *   `incr()`) — no caller needs to be touched.
 *
 * Naming convention:
 *   <subsystem>_<verb>_<outcome> in snake_case, all lowercase.
 *   `subsystem` ∈ ss | shopify | wms | webhook | reconcile
 *   `outcome` is what happened, e.g. `succeeded`, `failed`,
 *   `dead_letter`, `enqueued`, `processed`, `divergence`.
 *
 * Adding a new counter:
 *   1. Add to the `CounterName` union below
 *   2. Call `incr("new_counter_name", 1, { ... })` at the surface
 *   3. (Optional) extend `metrics.test.ts` with a smoke test
 *
 * Coding-standards: Rule #5 (no silent failures), Rule #15 (audit
 * trail). Counter increments do not throw; failures inside `incr()`
 * are caught + logged so a metrics-emit hiccup never poisons the
 * caller's hot path.
 */

export type CounterName =
  // ShipStation outbound push
  | "ss_push_attempted"
  | "ss_push_succeeded"
  | "ss_push_rejected"
  // ShipStation SHIP_NOTIFY inbound
  | "ss_ship_notify_received"
  | "ss_ship_notify_processed"
  | "ss_ship_notify_error"
  | "ss_ship_notify_dlq_enqueued"
  | "ss_ship_notify_dead_letter"
  // ShipStation reconcile sweep (V2)
  | "ss_reconcile_v2_processed"
  | "ss_reconcile_v2_divergence"
  | "ss_reconcile_v2_error"
  // Shopify fulfillment push
  | "shopify_push_attempted"
  | "shopify_push_succeeded"
  | "shopify_push_idempotent_skip"
  | "shopify_push_failed"
  | "shopify_push_dlq_enqueued"
  | "shopify_push_dead_letter"
  // Shopify fulfillment cancel
  | "shopify_cancel_attempted"
  | "shopify_cancel_succeeded"
  | "shopify_cancel_idempotent_skip"
  | "shopify_cancel_failed"
  // Shopify tracking-info update
  | "shopify_tracking_update_attempted"
  | "shopify_tracking_update_succeeded"
  | "shopify_tracking_update_idempotent_skip"
  | "shopify_tracking_update_failed"
  // Shopify webhook DLQ (orders/cancelled, refunds/create, fulfillments/*)
  | "shopify_webhook_retry_enqueued"
  | "shopify_webhook_retry_processed"
  | "shopify_webhook_dlq_dead_letter"
  // WMS sync + shipment lifecycle
  | "wms_sync_validation_failed"
  | "wms_shipment_created"
  | "wms_shipment_void_history_insert_failed";

export type MetricLabels = Record<string, string | number | boolean>;

/**
 * Increment a counter by `count` (default 1).
 *
 * Failures inside `incr()` (e.g. JSON.stringify on a bad value) are
 * swallowed + logged at warn level so a metrics emit hiccup never
 * poisons the caller's hot path.
 */
export function incr(
  metric: CounterName,
  count: number = 1,
  labels?: MetricLabels,
): void {
  try {
    const labelStr = formatLabels(labels);
    // Single line, machine-parsable. Log drains can split on whitespace.
    // The `metric=...` prefix is the marker that lets grep / log-search
    // distinguish counter increments from arbitrary `console.log` noise.
    if (labelStr) {
      console.log(`metric=${metric} count=${count} ${labelStr}`);
    } else {
      console.log(`metric=${metric} count=${count}`);
    }
  } catch (err: unknown) {
    // Never let metrics emission throw upstream.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[metrics] incr emit failed for ${metric}: ${msg}`);
  }
}

/**
 * Format labels into a `k1=v1 k2=v2` string for the structure-log
 * emit. Returns an empty string when labels are absent or empty.
 *
 * Values are coerced via String(); object/array values are
 * JSON.stringify'd inline so they don't break the line shape. Spaces
 * inside string values are replaced with underscores so each label
 * stays a single whitespace-delimited token.
 *
 * Exported for testability.
 */
export function formatLabels(labels?: MetricLabels): string {
  if (!labels) return "";
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      let str: string;
      if (v === null || v === undefined) {
        str = "null";
      } else if (typeof v === "object") {
        str = JSON.stringify(v);
      } else {
        str = String(v);
      }
      // Make each k=v a single token: replace any whitespace in the value
      // with underscores so log parsers can split cleanly on spaces.
      str = str.replace(/\s+/g, "_");
      return `${k}=${str}`;
    })
    .join(" ");
}
