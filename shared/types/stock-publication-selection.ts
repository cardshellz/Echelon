import { z } from "zod";
import { listingRetirementEvidenceSchema } from "./listing-member-lifecycle";

const id = z.number().int().positive().max(2_147_483_647);

/** Selection is an upstream listing decision, never a quantity or mapping proof. */
export const stockPublicationSelectionSchema = z.object({
  productId: id,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  variants: z.array(z.object({
    productVariantId: id,
    // Upstream listing intent is independent of inventory tracking and stock mode.
    // Older/custom readers may omit it; consumers must not infer exclusion then.
    listingSelected: z.boolean().optional(),
    action: z.enum(["publish", "zero", "read_only", "none"]),
    reason: z.string().trim().min(1).max(1_000),
    blockers: z.array(z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(100),
      message: z.string().trim().min(1).max(1_000),
    }).strict()),
    // Catalog archival cancels obsolete stock intent immediately. This flag
    // makes no claim about the independent remote listing removal.
    catalogArchived: z.literal(true).optional(),
    // Emitted only by the listing owner after it verifies removal of the exact
    // retained provider identity. Inventory may retire old work, never ACK it.
    retirementEvidence: listingRetirementEvidenceSchema.optional(),
  }).strict()),
}).strict().superRefine((value, context) => {
  if (new Set(value.variants.map(variant => variant.productVariantId)).size !== value.variants.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Each stock selection variant must appear exactly once." });
  if (value.variants.some(variant => variant.retirementEvidence && (variant.action !== "none" || variant.blockers.length > 0)))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Retirement evidence requires a verified end to publication duty." });
  if (value.variants.some(variant => variant.catalogArchived && variant.action !== "none"))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["variants"], message: "Archived catalog members cannot request stock publication." });
});

export type StockPublicationSelection = z.infer<typeof stockPublicationSelectionSchema>;

/** Reuse the caller's transaction. Readers never check out another connection. */
export interface StockSelectionQueryClient {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}
