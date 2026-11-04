import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierHeaderApprovalInputSchema, supplierHeaderPreviewSchema, type SupplierHeaderTarget } from "@shared/procurement/supplier-header-costs";
import { createPersistentFinancialIntentStore } from "@/lib/persistent-financial-intent";

export const supplierHeaderIntentSchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().uuid(),
  body: z.object({ request: supplierHeaderApprovalInputSchema, preview: supplierHeaderPreviewSchema }).strict(),
}).strict().superRefine((value, context) => {
  if (canonicalJson(value.body.request.target) !== canonicalJson(value.body.preview.target)
    || value.body.request.sourceVersion !== value.body.preview.sourceVersion || value.body.request.previewVersion !== value.body.preview.previewVersion)
    context.addIssue({ code: "custom", message: "Saved header approval and reviewed amounts disagree." });
});
export type SupplierHeaderIntent = z.infer<typeof supplierHeaderIntentSchema>;
export function createSupplierHeaderIntentStore(userId: string, target: SupplierHeaderTarget, storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  return createPersistentFinancialIntentStore({ userId, storage, storageKey: `supplier-header:${userId}:${target.kind}:${target.id}`,
    parse: raw => { const parsed = supplierHeaderIntentSchema.parse(raw);
      if (canonicalJson(parsed.body.request.target) !== canonicalJson(target)) throw new Error("Saved approval belongs to another supplier document.");
      return parsed; },
    messages: { read: "Browser recovery is unavailable. Reopen the review before approving.",
      corrupt: "The saved approval cannot be verified. Check its recorded outcome before starting another approval.",
      unresolved: "Resolve the saved approval before starting another update.", save: "Browser recovery must be available. No approval was sent.",
      clear: "Costs saved, but browser recovery remains. Reopening will verify the same approval." },
  });
}
