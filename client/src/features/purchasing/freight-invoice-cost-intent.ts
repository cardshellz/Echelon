import { z } from "zod";
import { freightInvoiceApprovalRequestSchema, freightInvoicePreviewSchema } from "@shared/procurement/freight-invoice-costs";
import { createPersistentFinancialIntentStore } from "@/lib/persistent-financial-intent";

export const freightInvoiceIntentSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), key: z.string().uuid(),
  body: z.object({ request: freightInvoiceApprovalRequestSchema, preview: freightInvoicePreviewSchema }).strict(),
}).strict().superRefine((value, context) => {
  if (value.body.request.sourceVersion !== value.body.preview.sourceVersion || value.body.request.previewVersion !== value.body.preview.previewVersion)
    context.addIssue({ code: "custom", message: "Saved approval and reviewed costs disagree." });
});
export type FreightInvoiceIntent = z.infer<typeof freightInvoiceIntentSchema>;
export function createFreightInvoiceIntentStore(userId: string, invoiceId: number, storage: () => Pick<Storage,"getItem"|"setItem"|"removeItem">) {
  return createPersistentFinancialIntentStore({
    userId, storage, storageKey: `freight-invoice-costs:${userId}:${invoiceId}`,
    parse: raw => {
      const record = freightInvoiceIntentSchema.parse(raw);
      if (record.body.preview.invoiceId !== invoiceId) throw new Error("Saved approval belongs to another invoice.");
      return record;
    },
    messages: {
      read: "Browser recovery is unavailable. Reopen the review before approving.",
      corrupt: "The saved approval cannot be verified. Check its recorded outcome before starting another approval.",
      unresolved: "Resolve the saved approval before creating another update.",
      save: "Browser recovery must be available before approval. No request was sent.",
      clear: "Costs saved, but browser recovery remains. Reopening will verify the same approval.",
    },
  });
}
