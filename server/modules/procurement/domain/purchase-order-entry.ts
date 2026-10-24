import type { PurchaseOrderEntryAction } from "@shared/procurement/purchase-order-entry-command";
import type { CommandAuthorityActor } from "../../identity";

export class PurchaseOrderEntryError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message); this.name = "PurchaseOrderEntryError";
  }
}

export function purchaseOrderEntryPermission(action: PurchaseOrderEntryAction): "create" | "edit" {
  return action === "save-draft" || action === "prepare-document" ? "edit" : "create";
}

export function assertPurchaseOrderEntryAuthority(actor: CommandAuthorityActor, action: PurchaseOrderEntryAction): void {
  const permission = purchaseOrderEntryPermission(action);
  if (!actor.active || !actor.permissions.includes(`purchasing:${permission}`)) {
    throw new PurchaseOrderEntryError("PURCHASE_ORDER_ENTRY_FORBIDDEN", `Your current account needs purchasing ${permission} permission to perform or recover this request.`, 403);
  }
}
