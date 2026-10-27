import type { Request } from "@playwright/test";
import { canonicalJson } from "../../shared/utils/canonical-json";
import type { PurchaseOrderEntryAction } from "../../shared/procurement/purchase-order-entry-command";

export function purchaseEntryFixture(request: Request, action: PurchaseOrderEntryAction, targetId: number | null, raw: Record<string, any>, actorId = "test-user") {
  const purchase = raw.po ?? raw;
  const lines = (raw.lines ?? purchase.lines ?? []).map((line: Record<string, unknown>, index: number) => ({ lineNumber: index + 1, ...line }));
  return { ...raw, po: { ...purchase, lineCount: lines.length }, lines,
    entryCommand: { action, targetId, actorId, idempotencyKey: request.headers()["idempotency-key"], purchaseOrderId: purchase.id,
      requestCanonical: canonicalJson({ action, targetId, payload: request.postData() ? request.postDataJSON() : {} }) } };
}
export const purchasingAuthFixture = { user: { id: "test-user", username: "test", role: "admin" }, permissions: ["purchasing:view", "purchasing:create", "purchasing:edit"], roles: ["admin"] };
