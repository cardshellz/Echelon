import type { PoPhysicalStatus } from "../schema/procurement.schema";

export interface PurchaseOrderStatusSource {
  readonly status?: string | null;
  readonly physicalStatus?: string | null;
}

const legacyPhysical: Readonly<Record<string, PoPhysicalStatus>> = {
  draft: "draft", pending_approval: "draft", approved: "draft", sent: "sent",
  acknowledged: "acknowledged", partially_received: "receiving", received: "received",
  closed: "received", cancelled: "cancelled",
};

/** Old rows retained the default physical value while the legacy track advanced.
 * This is the same compatibility rule used to authorize lifecycle transitions. */
export function resolveCurrentPhysicalStatus(po: PurchaseOrderStatusSource): PoPhysicalStatus {
  const physical = (po.physicalStatus ?? "draft") as PoPhysicalStatus;
  return physical === "draft" ? legacyPhysical[po.status ?? ""] ?? physical : physical;
}

const labels: Readonly<Record<string, string>> = {
  draft: "Draft", pending_approval: "Pending approval", approved: "Approved", sent: "Sent",
  acknowledged: "Acknowledged", shipped: "Shipped", in_transit: "In transit", arrived: "Arrived",
  receiving: "Partially received", received: "Received", short_closed: "Closed short",
  closed: "Closed", cancelled: "Cancelled",
};

/** Closure and approval are decisions on the PO. Otherwise its physical track
 * owns the current label; the legacy field cannot represent transit or arrival. */
export function purchaseOrderStatus(po: PurchaseOrderStatusSource): { code: string; label: string } {
  const physical = resolveCurrentPhysicalStatus(po);
  const code = po.status === "cancelled" || physical === "cancelled" ? "cancelled"
    : physical === "short_closed" ? "short_closed"
    : po.status === "closed" ? "closed"
    : physical === "draft" && ["pending_approval", "approved"].includes(po.status ?? "") ? po.status!
    : physical;
  return { code, label: labels[code] ?? "Status needs review" };
}
