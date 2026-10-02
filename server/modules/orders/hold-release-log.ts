import { WMS_HOLD_RELEASE_ERROR_CODES } from "@shared/wms-hold-release";

/**
 * One JSON line per hold-release decision (CLAUDE.md §10): level, action,
 * outcome, before/after, error code and the correlation ids. The durable
 * audit trail stays wms.picking_logs (order_unhold / line_item_released),
 * written only for real releases; this is the operational log.
 */

export type HoldReleaseLogOutcome =
  | "released"
  | "not_held"
  | "order_terminal"
  | "order_on_hold"
  | "not_found"
  | "failed";

export type HoldReleaseLogAction =
  | "order_hold_release"
  | "order_hold_release_sort_rank"
  | "line_hold_release"
  | "line_hold_release_push_enqueue";

export interface HoldReleaseLogEntry {
  action: HoldReleaseLogAction;
  outcome: HoldReleaseLogOutcome;
  wmsOrderId: number;
  omsOrderId?: string | null;
  orderItemId?: number | null;
  shipmentId?: number | null;
  actor: string | null;
  before?: unknown;
  after?: unknown;
  errorMessage?: string;
}

type LogLevel = "INFO" | "WARN" | "DEBUG";

// A release is a state transition. A replay of one, or a refusal the policy
// expects, changed nothing and is DEBUG. The only failures logged here follow
// a committed release and heal on their own (the stale-push reconciliation
// re-queues the push; the startup recompute rewrites the rank), so WARN.
const LEVEL_BY_OUTCOME: Record<HoldReleaseLogOutcome, LogLevel> = {
  released: "INFO",
  not_held: "DEBUG",
  order_terminal: "DEBUG",
  order_on_hold: "DEBUG",
  not_found: "DEBUG",
  failed: "WARN",
};

const REFUSAL_CODES: Partial<Record<HoldReleaseLogOutcome, string>> = {
  order_terminal: WMS_HOLD_RELEASE_ERROR_CODES.orderTerminal,
  order_on_hold: WMS_HOLD_RELEASE_ERROR_CODES.orderOnHold,
  not_found: WMS_HOLD_RELEASE_ERROR_CODES.notFound,
};

const FAILURE_CODES: Partial<Record<HoldReleaseLogAction, string>> = {
  line_hold_release_push_enqueue: WMS_HOLD_RELEASE_ERROR_CODES.pushEnqueueFailed,
  order_hold_release_sort_rank: WMS_HOLD_RELEASE_ERROR_CODES.sortRankFailed,
};

function errorCode(entry: HoldReleaseLogEntry): string | null {
  if (entry.outcome === "failed") return FAILURE_CODES[entry.action] ?? null;
  return REFUSAL_CODES[entry.outcome] ?? null;
}

export function formatHoldReleaseLog(entry: HoldReleaseLogEntry, now: Date): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: LEVEL_BY_OUTCOME[entry.outcome],
    action: entry.action,
    outcome: entry.outcome,
    error_code: errorCode(entry),
    actor: entry.actor,
    wms_order_id: entry.wmsOrderId,
    oms_order_id: entry.omsOrderId ?? null,
    order_item_id: entry.orderItemId ?? null,
    shipment_id: entry.shipmentId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ...(entry.errorMessage ? { error: entry.errorMessage } : {}),
  });
}

export function logHoldRelease(entry: HoldReleaseLogEntry, now: Date = new Date()): void {
  const line = formatHoldReleaseLog(entry, now);
  if (LEVEL_BY_OUTCOME[entry.outcome] === "WARN") console.warn(line);
  else console.log(line);
}
