import type { CustomerDeliveryStatus } from "@shared/customer-account/order-progress";
import type { CanonicalCarrierTrackingStatus } from "./carrier-tracking.domain";

const labels: Readonly<
  Record<CanonicalCarrierTrackingStatus, CustomerDeliveryStatus>
> = {
  unknown: { code: "unknown", label: "Tracking unavailable" },
  pre_transit: { code: "awaiting_carrier", label: "Awaiting carrier pickup" },
  accepted: { code: "shipped", label: "Shipped" },
  in_transit: { code: "in_transit", label: "In transit" },
  delivered: { code: "delivered", label: "Delivered" },
  exception: { code: "delivery_issue", label: "Delivery issue" },
  delivery_attempt: { code: "delivery_attempted", label: "Delivery attempted" },
  delivered_to_service_point: {
    code: "ready_for_pickup",
    label: "Ready for pickup",
  },
};
export function presentCarrierPackageStatus(
  status: CanonicalCarrierTrackingStatus | null,
): CustomerDeliveryStatus {
  return { ...labels[status ?? "unknown"] };
}
/** Only outbound packages belong here. Missing package evidence is retained as
 * unknown; two delivered packages can never complete a third unknown package. */
export function presentCustomerDelivery(
  packages: readonly CustomerDeliveryStatus[],
  fullyShipped: boolean,
): CustomerDeliveryStatus | null {
  if (!packages.length || packages.every((p) => p.code === "unknown"))
    return null;
  for (const code of [
    "delivery_issue",
    "delivery_attempted",
    "ready_for_pickup",
  ] as const) {
    const issue = packages.find((p) => p.code === code);
    if (issue) return { ...issue };
  }
  const delivered = packages.filter((p) => p.code === "delivered").length;
  if (delivered === packages.length && fullyShipped)
    return { ...labels.delivered };
  if (delivered > 0)
    return { code: "partially_delivered", label: "Partially delivered" };
  if (packages.some((p) => p.code === "in_transit"))
    return { ...labels.in_transit };
  if (packages.some((p) => p.code === "shipped")) return { ...labels.accepted };
  return { ...labels.pre_transit };
}
