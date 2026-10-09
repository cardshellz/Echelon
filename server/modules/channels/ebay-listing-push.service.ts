import { z } from "zod";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import type { EbayListingRebuildPreview } from "./listing-connectors/ebay-listing.connector";

const rebuildPreviewSchema: z.ZodType<EbayListingRebuildPreview> = z.object({
  productId: z.number().int().positive(), groupKey: z.string().trim().min(1).max(100),
  currentExternalListingId: z.string().trim().min(1).max(255), sourceState: z.enum(["active", "withdrawn"]),
  currentSkus: z.array(z.string().trim().min(1).max(100)).min(1),
  activeSkus: z.array(z.string().trim().min(1).max(100)), inactiveSkus: z.array(z.string().trim().min(1).max(100)),
  desiredSkus: z.array(z.string().trim().min(1).max(100)).min(1), addedSkus: z.array(z.string().trim().min(1).max(100)),
  removedSkus: z.array(z.string().trim().min(1).max(100)), rebuildRequired: z.boolean(),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ebayListingPushRequestSchema = z.object({
  productIds: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(500),
  updateExisting: z.object({ mode: z.literal("execute"), preview: rebuildPreviewSchema }).strict().optional(),
  rebuild: z.discriminatedUnion("mode", [z.object({ mode: z.literal("preview") }).strict(),
    z.object({ mode: z.literal("execute"), preview: rebuildPreviewSchema }).strict()]).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.productIds).size !== value.productIds.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["productIds"], message: "Choose each product only once." });
  if ((value.rebuild || value.updateExisting) && value.productIds.length !== 1)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["productIds"], message: "A reviewed listing change must target exactly one product." });
  if (value.rebuild && value.updateExisting)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["updateExisting"], message: "Choose either an in-place update or a rebuild, not both." });
  const preview = value.updateExisting?.preview ?? (value.rebuild?.mode === "execute" ? value.rebuild.preview : null);
  if (preview && preview.productId !== value.productIds[0])
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["productIds"], message: "The reviewed change belongs to a different product." });
});
export type EbayListingPushRequest = z.infer<typeof ebayListingPushRequestSchema>;
export interface EbayListingPushResult {
  productId: number; productName: string; variantCount: number; success: boolean;
  status: "success" | "error" | "skipped";
  listingId?: string; error?: string; code?: string; issue?: EbayListingIssue;
  variantDetails?: Array<{ sku: string; success: boolean; error?: string }>;
  rebuildPreview?: EbayListingRebuildPreview;
}
export class EbayListingPushSkipped extends Error {
  readonly code = "EBAY_LISTING_PREFLIGHT_FAILED";
}
export interface EbayListingPushProductOwner {
  execute(productId: number, command: EbayListingPushRequest, onRateLimit?: (seconds: number) => void): Promise<EbayListingPushResult>;
}
export interface EbayListingPushProgress {
  onProduct?: (result: EbayListingPushResult, current: number, total: number) => void;
  onRateLimit?: (seconds: number) => void;
  cancelled?: () => boolean;
}

/** Both HTTP and SSE use this batch boundary: one bad product cannot discard the
 * earlier results or prevent independent products from being attempted. */
export class EbayListingPushService {
  constructor(private readonly owner: EbayListingPushProductOwner) {}

  async push(command: EbayListingPushRequest, progress: EbayListingPushProgress = {}) {
    const parsed = ebayListingPushRequestSchema.parse(command);
    const results: EbayListingPushResult[] = [];
    for (const productId of parsed.productIds) {
      // Disconnect stops only between complete product workflows. Never abandon
      // a product's local projection while its provider work is finishing.
      if (progress.cancelled?.()) break;
      let result: EbayListingPushResult;
      try { result = await this.owner.execute(productId, parsed, progress.onRateLimit); }
      catch (error) { result = ebayListingPushFailure(productId, error); }
      results.push(result);
      progress.onProduct?.(result, results.length, parsed.productIds.length);
    }
    return { results, summary: {
      succeeded: results.filter(result => result.status === "success").length,
      failed: results.filter(result => result.status === "error").length,
      skipped: results.filter(result => result.status === "skipped").length,
      total: results.length,
    }, cancelled: progress.cancelled?.() ?? false };
  }
}

export function ebayListingPushFailure(productId: number, error: unknown, productName?: string): EbayListingPushResult {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && /^(EBAY_|PUBLICATION_|QUANTITY_|STOCK_|MARKETPLACE_)/.test(error.code)
    ? error.code : "EBAY_LISTING_OPERATION_FAILED";
  // Database/transport exceptions can contain query parameters or credentials.
  // Only classified application/provider diagnostics belong in the public result.
  const issue = resolveEbayListingIssue({ code, productId,
    message: code !== "EBAY_LISTING_OPERATION_FAILED" && error instanceof Error ? error.message : undefined });
  return { productId, productName: productName ?? `Product ${productId}`, variantCount: 0, success: false,
    status: error instanceof EbayListingPushSkipped ? "skipped" : "error", error: issue.message, code, issue };
}
