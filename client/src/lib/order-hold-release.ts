import {
  decideLineHoldRelease,
  hasOrderHoldFlag,
  isOpenHeldLine,
  isOrderLevelHold,
  isTerminalOrder,
} from "@shared/wms-hold-release";

/**
 * Orders page "On Hold" queue: what is held on an order, which release buttons
 * to offer, and the release request itself. The rules come from
 * @shared/wms-hold-release, the same functions the release endpoints enforce.
 */

export interface HoldReleaseLine {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  status: string;
  onHold?: boolean | null;
  holdReason?: string | null;
}

export interface HoldReleaseOrder {
  id: number;
  orderNumber: string;
  onHold: number | boolean | null;
  heldAt?: string | null;
  warehouseStatus: string;
  items?: HoldReleaseLine[] | null;
}

export type HoldReleaseTarget =
  | { kind: "order"; orderId: number; orderNumber: string }
  | {
      kind: "line";
      orderId: number;
      orderNumber: string;
      itemId: number;
      sku: string;
      quantity: number;
    };

export interface HeldLineView {
  line: HoldReleaseLine;
  target: HoldReleaseTarget;
  /** Why the hold policy refuses this release now; null when it is allowed. */
  blockedReason: string | null;
}

export interface OrderHoldView {
  isHeld: boolean;
  /** The viewer holds orders:hold. Without it every Release stays disabled. */
  canRelease: boolean;
  /** The whole-order hold that Release clears; null when the flag is not set. */
  orderHold: { target: HoldReleaseTarget; heldAt: string | null; blockedReason: string | null } | null;
  /** Legacy 'on_hold' warehouse status without the flag: nothing here clears it. */
  statusOnlyHold: boolean;
  heldLines: HeldLineView[];
}

export const RELEASE_NEEDS_PERMISSION = "Releasing holds needs the orders:hold permission (leads and admins).";
export const RELEASE_ORDER_HOLD_FIRST = "Release the order hold first.";
export const RELEASE_ORDER_CLOSED = "This order is closed; there is nothing to release.";

export function buildOrderHoldView(order: HoldReleaseOrder, canRelease: boolean): OrderHoldView {
  const terminal = isTerminalOrder(order);

  const orderHold = hasOrderHoldFlag(order)
    ? {
        target: { kind: "order", orderId: order.id, orderNumber: order.orderNumber } as const,
        heldAt: order.heldAt ?? null,
        blockedReason: terminal ? RELEASE_ORDER_CLOSED : null,
      }
    : null;

  const heldLines = (order.items ?? []).filter(isOpenHeldLine).map((line): HeldLineView => {
    const decision = decideLineHoldRelease({
      wmsOrderId: order.id,
      order: { id: order.id, onHold: order.onHold, warehouseStatus: order.warehouseStatus },
      line: { orderId: order.id, onHold: line.onHold, status: line.status, quantity: line.quantity },
    });
    const blockedReason =
      decision === "order_terminal" ? RELEASE_ORDER_CLOSED
      : decision === "order_on_hold" ? RELEASE_ORDER_HOLD_FIRST
      : null;
    return {
      line,
      target: {
        kind: "line",
        orderId: order.id,
        orderNumber: order.orderNumber,
        itemId: line.id,
        sku: line.sku,
        quantity: line.quantity,
      },
      blockedReason,
    };
  });

  const statusOnlyHold = !orderHold && isOrderLevelHold(order) && !terminal;
  return {
    isHeld: orderHold !== null || statusOnlyHold || heldLines.length > 0,
    canRelease,
    orderHold,
    statusOnlyHold,
    heldLines,
  };
}

export function countOpenHeldLines(order: Pick<HoldReleaseOrder, "items">): number {
  return (order.items ?? []).filter(isOpenHeldLine).length;
}

export function holdReleaseEndpoint(target: HoldReleaseTarget): string {
  return target.kind === "order"
    ? `/api/orders/${target.orderId}/release-hold`
    : `/api/orders/${target.orderId}/items/${target.itemId}/release-hold`;
}

/** "3d 4h", "5h 12m", "12m", "under a minute"; null without a hold time. */
export function formatHeldFor(heldAt: string | null | undefined, now: Date): string | null {
  if (!heldAt) return null;
  const since = Date.parse(heldAt);
  if (Number.isNaN(since)) return null;
  const minutes = Math.floor(Math.max(0, now.getTime() - since) / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function describeHoldRelease(target: HoldReleaseTarget): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (target.kind === "order") {
    return {
      title: `Release order ${target.orderNumber} from hold?`,
      description:
        "The order goes back to the pick queue and its ShipStation order is released, so it can be picked and shipped. Lines held on their own stay held.",
      confirmLabel: "Release order",
    };
  }
  return {
    title: `Release ${target.sku} on ${target.orderNumber}?`,
    description: `The line (qty ${target.quantity}) ships on its own as a separate ShipStation order. The rest of the order is not affected.`,
    confirmLabel: "Release line",
  };
}

export function describeReleaseOutcome(
  target: HoldReleaseTarget,
  released: boolean,
): { title: string; description: string } {
  const subject = target.kind === "order" ? `Order ${target.orderNumber}` : `${target.sku} on ${target.orderNumber}`;
  return released
    ? {
        title: "Hold released",
        description: target.kind === "order"
          ? `${subject} is back in the pick queue.`
          : `${subject} will ship on its own.`,
      }
    : { title: "Already released", description: `${subject} was not on hold any more. Nothing changed.` };
}

export class HoldReleaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "HoldReleaseRequestError";
  }
}

export function readHoldReleaseError(status: number, body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const serverMessage = typeof record?.error === "string" ? record.error.trim() : "";
  if (serverMessage) return serverMessage;
  if (status === 401) return "Your session expired. Sign in again to release holds.";
  if (status === 403) return RELEASE_NEEDS_PERMISSION;
  return "The release did not go through. Try again.";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** POSTs the release. Resolves `released: false` when it was already released. */
export async function requestHoldRelease(
  target: HoldReleaseTarget,
  fetchImpl: FetchLike = fetch,
): Promise<{ released: boolean }> {
  const response = await fetchImpl(holdReleaseEndpoint(target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && typeof (body as any).code === "string"
      ? (body as any).code as string
      : null;
    throw new HoldReleaseRequestError(readHoldReleaseError(response.status, body), response.status, code);
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return { released: target.kind === "order" ? record.holdReleased === true : record.released === true };
}
