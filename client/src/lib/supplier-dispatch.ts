import { z } from "zod";

const dispatchResultSchema = z.discriminatedUnion("status", [
  z.object({ id: z.number().int().positive(), status: z.literal("sent"), physicalStatus: z.literal("sent"), sentToVendorAt: z.string().datetime({ offset: true }) }),
  z.object({ id: z.number().int().positive(), status: z.literal("pending_approval"), physicalStatus: z.literal("draft") }),
]);

export function parseSupplierDispatchResult(value: unknown, purchaseOrderId: number): "recorded" | "approval_required" {
  const parsed = dispatchResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== purchaseOrderId) {
    throw new Error("Supplier dispatch could not be verified. Reload this PO and review its history before trying again.");
  }
  return parsed.data.status === "sent" ? "recorded" : "approval_required";
}

export function supplierDispatchReviewedVersion(value: unknown): string {
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  if (!parsed.success) throw new Error("The reviewed PO version is unavailable. Reload the PO before recording an external send.");
  return new Date(parsed.data).toISOString();
}

const supplierPreparationResultSchema = z.object({
  id: z.number().int().positive(), poNumber: z.string().min(1),
  status: z.enum(["approved", "pending_approval"]), physicalStatus: z.literal("draft"),
});

export function parseSupplierPreparationResult(value: unknown, expectedPurchaseOrderId?: number) {
  const parsed = supplierPreparationResultSchema.safeParse(value);
  if (!parsed.success || (expectedPurchaseOrderId !== undefined && parsed.data.id !== expectedPurchaseOrderId)) {
    throw new Error("PO preparation could not be verified. Reload the saved PO before continuing; supplier dispatch has not been confirmed.");
  }
  return parsed.data;
}

const supplierSaveResultSchema = z.object({
  po: supplierPreparationResultSchema.extend({
    status: z.enum(["draft", "approved", "pending_approval"]),
    updatedAt: z.string().datetime({ offset: true }).optional(),
  }),
  status: z.enum(["draft", "approved", "pending_approval"]).optional(),
  dispatch_recorded: z.literal(false).optional(),
  pending_approval: z.boolean().optional(),
  sendError: z.string().trim().min(1).optional(),
});

/** Saving can commit before preparation fails; validate the saved identity in both outcomes. */
export function parseSupplierSaveResult(value: unknown, preparationRequested: boolean, expectedPurchaseOrderId?: number) {
  const parsed = supplierSaveResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("PO save could not be verified. Reload purchase orders and check whether this PO was saved before retrying.");
  }
  const result = parsed.data;
  if ((expectedPurchaseOrderId !== undefined && result.po.id !== expectedPurchaseOrderId)
    || (result.status !== undefined && result.status !== result.po.status)
    || (result.pending_approval !== undefined && result.pending_approval !== (result.po.status === "pending_approval"))
    || (preparationRequested && result.dispatch_recorded !== false)
    || (!preparationRequested && (result.po.status !== "draft" || result.sendError !== undefined))) {
    throw new Error("PO save could not be verified. Reload purchase orders and check whether this PO was saved before retrying.");
  }
  if (preparationRequested && result.sendError === undefined) {
    parseSupplierPreparationResult(result.po);
  }
  return { po: result.po, preparationError: result.sendError ?? null };
}
