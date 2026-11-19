import { z } from "zod";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const MAX_SAVED_ORDER_LINES = 500;
const id = z.number().int().positive().safe();
const savedLineSchema = z.object({
  recommendationId: z.string().min(1).max(200), productId: id, productVariantId: id.nullable(),
  vendorProductId: id.nullable(), pieces: z.number().int().nonnegative().safe(),
  exceedReason: z.string().max(2000),
}).strict();
const bodySchema = z.object({
  targetRecommendationId: z.string().min(1).max(200),
  lines: z.array(savedLineSchema).min(1).max(MAX_SAVED_ORDER_LINES),
  vendorModes: z.record(z.enum(["po", "rfq"])), decisionNote: z.string().max(2000),
}).strict().superRefine((body, context) => {
  const identities = new Set(body.lines.map(line => line.recommendationId));
  if (identities.size !== body.lines.length || !identities.has(body.targetRecommendationId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The saved order must contain each selected recommendation exactly once, including its supplier setup target." });
  }
  if (Object.keys(body.vendorModes).length > MAX_SAVED_ORDER_LINES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The saved order contains too many supplier groups." });
  }
});
const recordSchema = z.object({ version: z.literal(1), userId: z.string().min(1),
  key: z.string().min(8).max(128), body: bodySchema }).strict();
export type OrderSupplierHandoffBody = z.infer<typeof bodySchema>;
export type OrderSupplierHandoff = z.infer<typeof recordSchema>;

export interface SupplierHandoffItem {
  recommendationId: string; productId: number; productVariantId?: number;
  preferredVendorId: number | null; skippedReason?: string | null;
  supplierBasis: { vendorProductId: number | null; sourcingSelection?: { options: Array<{ vendorProductId: number; eligible: boolean }> } | null };
}
type Selection = ReadonlyMap<string, { pieces: number; exceedReason: string }>;

/** Save operator intent only. Quote amounts, approval acknowledgements and command results
 * are deliberately absent: the current engine and financial owners still supply them. */
export function captureOrderSupplierHandoff(targetRecommendationId: string, items: readonly SupplierHandoffItem[],
  selection: Selection, supplierOverrides: Readonly<Record<string, number>>, vendorModes: Record<string, "po" | "rfq">,
  decisionNote: string): OrderSupplierHandoffBody {
  const byId = new Map(items.map(item => [item.recommendationId, item]));
  const target = byId.get(targetRecommendationId);
  if (!target || target.preferredVendorId !== null || !selection.has(targetRecommendationId)) {
    throw new Error("Select a recommendation that still needs a supplier before opening supplier setup.");
  }
  return bodySchema.parse({ targetRecommendationId, vendorModes, decisionNote,
    lines: [...selection].map(([recommendationId, state]) => {
      const item = byId.get(recommendationId);
      if (!item || item.skippedReason === "excluded") throw new Error("A selected recommendation changed. Refresh and review the order before supplier setup.");
      return { recommendationId, productId: item.productId, productVariantId: item.productVariantId ?? null,
        vendorProductId: supplierOverrides[recommendationId] ?? item.supplierBasis.vendorProductId,
        pieces: state.pieces, exceedReason: state.exceedReason };
    }),
  });
}

export function orderSupplierSetupHref(raw: OrderSupplierHandoffBody): string {
  const body = bodySchema.parse(raw);
  const target = body.lines.find(line => line.recommendationId === body.targetRecommendationId)!;
  const query = new URLSearchParams({ setupProductId: String(target.productId),
    recommendationId: target.recommendationId, setupAction: "assign_vendor", returnTo: "/reorder-analysis" });
  if (target.productVariantId !== null) query.set("setupVariantId", String(target.productVariantId));
  return "/suppliers?" + query.toString();
}

export function restoreOrderSupplierHandoff(raw: OrderSupplierHandoffBody, current: readonly SupplierHandoffItem[]) {
  const body = bodySchema.parse(raw);
  const byId = new Map(current.map(item => [item.recommendationId, item]));
  const selection = new Map<string, { pieces: number; exceedReason: string }>();
  const supplierOverrides: Record<string, number> = Object.create(null);
  for (const line of body.lines) {
    const item = byId.get(line.recommendationId);
    if (!item || item.skippedReason === "excluded" || item.productId !== line.productId
      || (item.productVariantId ?? null) !== line.productVariantId) {
      throw new Error("A saved recommendation is unavailable or its receive unit changed. Review the saved order before discarding or replacing it.");
    }
    if (line.vendorProductId !== null && line.vendorProductId !== item.supplierBasis.vendorProductId) {
      const choice = item.supplierBasis.sourcingSelection?.options.find(option => option.vendorProductId === line.vendorProductId && option.eligible);
      if (!choice) throw new Error("A saved supplier choice is no longer eligible. Review the saved order before discarding or replacing it.");
      supplierOverrides[line.recommendationId] = line.vendorProductId;
    }
    selection.set(line.recommendationId, { pieces: line.pieces, exceedReason: line.exceedReason });
  }
  return { selection, supplierOverrides, vendorModes: body.vendorModes, decisionNote: body.decisionNote };
}

export function createOrderSupplierHandoffStore(storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before saving an order for supplier setup.");
  const storageKey = "echelon:order-supplier-handoff:v1:" + encodeURIComponent(userId);
  const store = createPersistentFinancialIntentStore<OrderSupplierHandoffBody, OrderSupplierHandoff>({
    storage, storageKey, userId, parse: raw => recordSchema.parse(raw), messages: {
      read: "The saved order cannot be read. Restore session storage before leaving for supplier setup.",
      corrupt: "The saved order could not be verified. Review or explicitly discard it before starting another supplier setup.",
      unresolved: "An earlier order is saved for supplier setup. Review or discard it before replacing it.",
      save: "The order could not be saved. Supplier setup was not opened; your current selection is still here.",
      clear: "The saved order could not be cleared. Restore session storage and try again.",
    },
  });
  return { ...store, discard() {
    try { storage().removeItem(storageKey); }
    catch { throw new Error("The saved order could not be discarded. Restore session storage and try again."); }
  } };
}
