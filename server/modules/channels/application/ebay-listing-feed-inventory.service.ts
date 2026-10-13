import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ebayListingIssueSchema, type EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { InventoryChannelQuantityRuntimeError, InventoryPublicationSelectionError } from "../../inventory-planning/channel-quantity";

export interface EbayFeedInventoryReader {
  getAtpPerVariant(productId: number): Promise<readonly { productVariantId: number; atpUnits: number }[]>;
}

export interface EbayFeedInventoryDiagnostics {
  createReference(): string;
  reportFailure(failure: { productId: number; reference: string; code: string; error: unknown }): void;
}

export interface EbayFeedInventoryResult {
  quantities: ReadonlyMap<number, number | null>;
  issue: EbayListingIssue | null;
}

class FeedQuantityResultError extends Error {
  constructor(readonly code: "EBAY_FEED_QUANTITY_MISSING" | "EBAY_FEED_QUANTITY_INVALID", readonly missingVariantIds: readonly number[] = []) {
    super(code);
    this.name = "FeedQuantityResultError";
  }
}

/** Isolates read failures by product; never substitutes stock or changes listing state. */
export class EbayListingFeedInventoryService {
  constructor(private readonly reader: EbayFeedInventoryReader, private readonly diagnostics: EbayFeedInventoryDiagnostics) {}

  async readProduct(productId: number, variantIds: readonly number[], requiredVariantIds: readonly number[] = variantIds): Promise<EbayFeedInventoryResult> {
    if (!isIdentifier(productId) || variantIds.some(id => !isIdentifier(id)) || new Set(variantIds).size !== variantIds.length
      || requiredVariantIds.some(id => !variantIds.includes(id)) || new Set(requiredVariantIds).size !== requiredVariantIds.length) {
      throw new TypeError("Listing feed inventory requires one product and distinct positive variant identifiers.");
    }
    let validatedQuantities: ReadonlyMap<number, number> = new Map();
    try {
      const rows = variantIds.length > 0 ? await this.reader.getAtpPerVariant(productId) : [];
      const quantities = new Map<number, number>();
      for (const row of rows) {
        if (!isIdentifier(row.productVariantId) || !Number.isSafeInteger(row.atpUnits)
          || row.atpUnits < 0 || quantities.has(row.productVariantId)) {
          throw new FeedQuantityResultError("EBAY_FEED_QUANTITY_INVALID");
        }
        quantities.set(row.productVariantId, row.atpUnits);
      }
      validatedQuantities = quantities;
      // The listing owner's existing eligibility selectors identify required
      // rows. Excluded/nonmanaged display variants may legitimately have none.
      // Missing stock is never zero; a missing sibling must not erase valid rows.
      const missingVariantIds = requiredVariantIds.filter(id => !quantities.has(id));
      if (missingVariantIds.length > 0) throw new FeedQuantityResultError("EBAY_FEED_QUANTITY_MISSING", missingVariantIds);
      return { quantities: new Map(variantIds.map(id => [id, quantities.get(id) ?? null])), issue: null };
    } catch (error) {
      const reference = this.diagnostics.createReference();
      const code = error instanceof FeedQuantityResultError ? error.code
        : error instanceof InventoryChannelQuantityRuntimeError && PUBLIC_QUANTITY_CODES.has(error.code)
          ? error.code : error instanceof InventoryPublicationSelectionError && PUBLIC_SELECTION_CODES.has(error.code)
            ? error.code : "EBAY_FEED_QUANTITY_UNAVAILABLE";
      this.diagnostics.reportFailure({ productId, reference, code, error });
      const blockerCodes = error instanceof InventoryChannelQuantityRuntimeError && Array.isArray(error.context.blockerCodes)
        ? error.context.blockerCodes.filter((value): value is string => typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value)).slice(0, 10)
        : [];
      const issue = resolveEbayListingIssue({ code, productId, jobId: reference, quantityBlockerCodes: blockerCodes });
      if (error instanceof FeedQuantityResultError && error.missingVariantIds.length > 0) {
        issue.details = [...(issue.details ?? []), { label: "Variants without quantities", value: error.missingVariantIds.join(", ").slice(0, 1000) }];
      }
      if (error instanceof InventoryChannelQuantityRuntimeError) {
        const details = [...(issue.details ?? [])];
        const { productVariantId, publicationTargetId } = error.context;
        if (isIdentifier(productVariantId)) details.push({ label: "Variant ID", value: String(productVariantId) });
        if (isIdentifier(publicationTargetId)) details.push({ label: "Stock destination ID", value: String(publicationTargetId) });
        for (const blockerCode of blockerCodes) details.push({ label: "Inventory check", value: blockerCode });
        issue.details = details;
      }
      return { quantities: new Map(variantIds.map(id => [id, validatedQuantities.get(id) ?? null])), issue: ebayListingIssueSchema.parse(issue) };
    }
  }
}

const PUBLIC_QUANTITY_CODES = new Set([
  "CANONICAL_CHANNEL_QUANTITY_BLOCKED",
  "CANONICAL_CHANNEL_QUANTITY_TARGET_AMBIGUOUS",
  "CANONICAL_CHANNEL_QUANTITY_TARGET_DUPLICATE",
]);
const PUBLIC_SELECTION_CODES = new Set([
  "CHANNEL_SELECTION_CONNECTION_UNRESOLVED", "CHANNEL_SELECTION_JOB_SCOPE_CHANGED", "CHANNEL_SELECTION_AMBIGUOUS",
  "PUBLICATION_SELECTION_DESTINATION_INVALID", "PUBLICATION_SELECTION_IDENTITY_INCOMPLETE",
]);

function isIdentifier(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
