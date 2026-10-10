import {
  ebayListingSyncJobSchema,
  ebayProductSyncResultSchema,
  type EbayProductSyncResult,
  type EbayListingSyncJob,
} from "@shared/types/ebay-listing-sync";
import {
  EbayListingSyncError,
  type EbayListingSyncIdentity,
  type StoredEbayListingSyncJob,
} from "./ebay-listing-sync.domain";

export interface EbayListingSyncAdmissionProduct {
  readonly productId: number;
  readonly productName: string;
  readonly variants: readonly { variantId: number; sku: string | null }[];
  captureIdentity(): EbayListingSyncIdentity;
}
export interface EbayListingSyncAdmissionFailure {
  readonly channelId: number;
  readonly productId: number;
  readonly variantIds: readonly number[];
  readonly actor: string;
  readonly commandKey: string;
  readonly code: string;
  readonly message: string;
}
export interface EbayListingSyncAdmissionDependencies {
  enqueue(identity: EbayListingSyncIdentity, actor: string, commandKey: string): Promise<StoredEbayListingSyncJob>;
  recordFailure(failure: EbayListingSyncAdmissionFailure): Promise<EbayListingSyncJob>;
  uuid(): string;
}

/** Each product is its own durable command; rejection never discards unrelated accepted work. */
export async function admitEbayListingSyncProducts(
  products: readonly EbayListingSyncAdmissionProduct[],
  input: { channelId: number; actor: string; commandKey?: string },
  dependencies: EbayListingSyncAdmissionDependencies,
): Promise<EbayProductSyncResult> {
  if (input.commandKey && products.length !== 1) {
    throw new EbayListingSyncError("EBAY_SYNC_COMMAND_SCOPE_INVALID", "A command key must target one product.");
  }
  const summary = ebayProductSyncResultSchema.parse({ synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, details: [] });
  for (const product of products) {
    const commandKey = input.commandKey ?? dependencies.uuid();
    try {
      const job = await dependencies.enqueue(product.captureIdentity(), input.actor, commandKey);
      addJobResult(summary, job, product.productName);
    } catch (error) {
      const failure = classifyAdmissionFailure(error);
      let message = failure.message;
      let code = failure.code;
      console.error(JSON.stringify({ event: "ebay_listing_sync_admission_failed", productId: product.productId, commandKey, code }));
      try {
        const saved = await dependencies.recordFailure({
          channelId: input.channelId, productId: product.productId,
          variantIds: product.variants.map(variant => variant.variantId),
          actor: input.actor, commandKey, ...failure,
        });
        summary.jobs.push(ebayListingSyncJobSchema.parse(saved));
      } catch {
        // The HTTP response must distinguish an unsaved admission from a durable job.
        message += " This sync request could not be saved; retry this product after the connection recovers.";
        code = "EBAY_SYNC_ADMISSION_UNSAVED";
        console.error(JSON.stringify({ event: "ebay_listing_sync_admission_unsaved", productId: product.productId, commandKey, code }));
      }
      const variants = product.variants.length ? product.variants : [{ variantId: undefined, sku: null }];
      summary.errors += variants.length;
      for (const variant of variants) {
        summary.details.push({ success: false, productId: product.productId, productName: product.productName,
          variantId: variant.variantId, variantSku: variant.sku ?? undefined, code, error: message });
      }
    }
  }
  return ebayProductSyncResultSchema.parse(summary);
}

function addJobResult(summary: EbayProductSyncResult, job: StoredEbayListingSyncJob, productName: string): void {
  summary.jobs.push(ebayListingSyncJobSchema.parse(job));
  if (job.state === "completed" && job.result) {
    for (const field of ["synced", "priceChanges", "qtyChanges", "policyChanges", "errors"] as const) summary[field] += job.result[field];
    summary.details.push(...job.result.details);
  } else if (job.state === "needs_attention" || job.state === "awaiting_evidence") {
    summary.errors += job.identity.variants.length;
    summary.details.push(...job.identity.variants.map(member => ({ success: false, productId: job.productId, productName,
      variantId: member.variantId, variantSku: member.catalogSku ?? member.sku, code: job.code ?? undefined,
      error: job.message ?? "The saved sync job needs attention." })));
  } else {
    summary.pending++;
  }
}

function classifyAdmissionFailure(error: unknown): { code: string; message: string } {
  return error instanceof EbayListingSyncError
    ? { code: error.code, message: error.message }
    : { code: "EBAY_SYNC_ADMISSION_FAILED", message: "The listing sync request could not be saved. Retry this product; other accepted products will continue." };
}
