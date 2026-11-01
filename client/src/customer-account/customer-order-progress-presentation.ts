import type { CustomerOrderProgress } from "@shared/customer-account/order-progress";
import type { CustomerOrderFulfillment } from "@shared/customer-account/order-fulfillment";

export function orderDeliveryLabel(
  cancelled: boolean,
  fulfillment: CustomerOrderFulfillment | undefined,
  progress: CustomerOrderProgress | null | undefined,
  fallback: string,
): string | null {
  const carrier = progress?.delivery;
  const physicallyMoving = carrier && !["awaiting_carrier", "unknown"].includes(carrier.code);
  if (cancelled && !physicallyMoving && !["shipped", "partially_shipped"].includes(fulfillment?.code ?? "")) return null;
  if (carrier && (!cancelled || physicallyMoving)) return carrier.label;
  if (["cancelled", "cancelling"].includes(fulfillment?.code ?? "")) return null;
  return fulfillment?.label ?? fallback;
}

export function returnProgressLabel(
  progress: CustomerOrderProgress | null | undefined,
): string | null {
  if (progress === null || progress?.unavailable.includes("returns"))
    return "Status unavailable";
  const requests = progress?.returns ?? [];
  if (!requests.length) return null;
  if (requests.some(request => request.status.code === "needs_attention")) return "Needs attention";
  if (requests.some(request => request.status.code === "delivery_issue")) return "Delivery issue";
  if (
    requests.every((request) => request.status.code === requests[0].status.code)
  )
    return requests[0].status.label;
  const active = requests.filter(
    (request) => !["complete", "cancelled"].includes(request.status.code),
  );
  if (!active.length) return "Closed";
  return active.length === 1
    ? active[0].status.label
    : `${active.length} returns in progress`;
}
export function refundActivityLabel(
  financialStatus: string,
  progress: CustomerOrderProgress | null | undefined,
): string | null {
  if (financialStatus.toLowerCase() === "refunded") return null;
  const statuses = progress?.refunds.map((refund) => refund.status.code) ?? [];
  if (statuses.includes("failed")) return "Refund needs attention";
  if (statuses.includes("processing")) return "Refund processing";
  if (
    !financialStatus.toLowerCase().includes("refunded") &&
    statuses.some(
      (code) => code === "completed" || code === "partially_completed",
    )
  )
    return "Refund issued";
  if (progress === null || progress?.unavailable.includes("refunds"))
    return "Refund status unavailable";
  return null;
}
