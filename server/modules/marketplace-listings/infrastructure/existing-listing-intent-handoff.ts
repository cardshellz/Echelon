import type { ListingIntentLifecycleService } from "../application/listing-intent-lifecycle.service";
import {
  DROPSHIP_LISTING_ACCESS_BLOCK_CODES,
  DROPSHIP_LISTING_ACCESS_RESOLUTIONS,
} from "../../../../shared/dropship/listing-access";
import { z } from "zod";
import type { Pool } from "pg";
import type { ListingIntentHandoffPort } from "../application/listing-intent-propagation.service";
import type {
  IntentDelivery,
  IntentHandoff,
} from "../domain/listing-intent-propagation";
import type { EbayListingSyncService } from "../../channels/ebay-listing-sync.service";
import type { syncActiveListings } from "../../channels/ebay-listing-sync";
import { PgDropshipListingPreviewRepository } from "../../dropship/infrastructure/dropship-listing-preview.repository";
import type { DropshipListingPreviewService } from "../../dropship/application/dropship-listing-preview-service";

const ACTOR = "system:listing-intent-propagation";
const blocked = (code: string, message: string): IntentHandoff => ({
  state: "blocked",
  code,
  message,
});
/** These existing owner errors confirm a refusal, rather than an unknown
 * admission outcome. Transport and persistence failures must keep their command
 * for receipt-first replay. Access decisions remain with the Dropship owner. */
const ADMISSION_REFUSAL_CODES = new Set<string>([
  ...DROPSHIP_LISTING_ACCESS_BLOCK_CODES,
  "LISTING_INTENT_LIFECYCLE_SCOPE_CHANGED",
  "EBAY_SYNC_IDENTITY_CHANGED",
  "EBAY_SYNC_ACCOUNT_UNVERIFIED",
  "EBAY_SYNC_AUTH_REQUIRED",
  "DROPSHIP_LISTING_ACCOUNT_CHANGED",
  "DROPSHIP_LISTING_MANAGED_SCOPE_CHANGED",
  "DROPSHIP_IDEMPOTENCY_CONFLICT",
  "EBAY_POLICY_UNAVAILABLE",
  "EBAY_POLICY_REQUIRED",
  "EBAY_POLICY_SCOPE_CHANGED",
]);

function admissionRefusal(
  error: unknown,
): (IntentHandoff & { state: "blocked" }) | null {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : null;
  if (typeof code !== "string" || !ADMISSION_REFUSAL_CODES.has(code))
    return null;
  const accessBlock = DROPSHIP_LISTING_ACCESS_BLOCK_CODES.some(
    (value) => value === code,
  );
  const resolution = z
    .enum(DROPSHIP_LISTING_ACCESS_RESOLUTIONS)
    .safeParse(
      error && typeof error === "object"
        ? (error as { context?: { resolution?: unknown } }).context?.resolution
        : undefined,
    );
  return {
    state: "blocked",
    code,
    message:
      accessBlock && error instanceof Error && error.message.trim()
        ? error.message.slice(0, 1000)
        : "The change is saved, but its account, listing identity or required policy needs review in the listing workspace before an update can be accepted.",
    ...(accessBlock && resolution.success
      ? { resolution: resolution.data }
      : {}),
  };
}

/** Adapts only durable admission. Provider preparation and execution continue in
 * the existing owner. Reading an accepted command precedes fresh intent. */
export class ExistingListingIntentHandoff implements ListingIntentHandoffPort {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly dropship: Pick<
      DropshipListingPreviewService,
      "createListingPushJob"
    >,
    private readonly ebay: {
      channelId: number;
      service: Pick<EbayListingSyncService, "getByCommand" | "getAdmission">;
      sync: typeof syncActiveListings;
    },
    private readonly lifecycle: Pick<ListingIntentLifecycleService, "assess">,
  ) {}

  async handoff(delivery: IntentDelivery): Promise<IntentHandoff> {
    try {
      return await this.admit(delivery);
    } catch (error) {
      const refusal = admissionRefusal(error);
      if (!refusal) throw error;
      console.error(
        JSON.stringify({
          event: "listing_intent_handoff_blocked",
          deliveryId: delivery.id,
          code: refusal.code,
        }),
      );
      return refusal;
    }
  }

  private async admit(delivery: IntentDelivery): Promise<IntentHandoff> {
    const d = delivery.destination;
    if (
      d.kind === "channel" &&
      d.provider === "ebay" &&
      d.channelId === this.ebay.channelId
    ) {
      const prior = await this.ebay.service.getByCommand(
        delivery.commandKey,
        d.channelId,
        ACTOR,
        "sync",
      );
      if (prior) {
        if (
          prior.productId !== delivery.productId ||
          prior.identity.connectionId !== d.connectionId ||
          prior.identity.accountId !== d.accountId ||
          prior.identity.marketplaceId !== d.marketplaceId
        )
          return blocked(
            "LISTING_INTENT_RECEIPT_SCOPE_CONFLICT",
            "The saved update belongs to another product or account. Review the listing connection.",
          );
        return {
          state: "delivered",
          receipt: {
            owner: "ebay_listing_sync",
            operationId: prior.id,
            commandKey: delivery.commandKey,
          },
        };
      }
      const disposition = await this.lifecycle.assess(delivery);
      if (disposition) return disposition;
      const rejected = await this.ebay.service.getAdmission(
        delivery.commandKey,
        d.channelId,
      );
      if (rejected)
        return blocked(
          rejected.code ?? "LISTING_INTENT_ADMISSION_BLOCKED",
          rejected.message ??
            "Review this listing before retrying its saved change.",
        );
      const result = await this.ebay.sync(
        { productIds: [delivery.productId] },
        ACTOR,
        delivery.commandKey,
        {
          connectionId: d.connectionId,
          accountId: z.string().min(1).parse(d.accountId),
          environment: z.enum(["production", "sandbox"]).parse(d.environment),
          marketplaceId: z.string().min(1).parse(d.marketplaceId),
        },
      );
      const job = result.jobs.find(
        (row) => row.productId === delivery.productId,
      );
      if (job?.kind === "admission")
        return blocked(
          job.code ?? "LISTING_INTENT_ADMISSION_BLOCKED",
          job.message ??
            "Review this listing before retrying its saved change.",
        );
      if (!job)
        return blocked(
          "LISTING_INTENT_LISTING_UNAVAILABLE",
          "This product has no existing listing available to update. Review its saved listing mapping.",
        );
      return {
        state: "delivered",
        receipt: {
          owner: "ebay_listing_sync",
          operationId: job.id,
          commandKey: delivery.commandKey,
        },
      };
    }
    if (d.kind === "dropship" && d.provider === "ebay") {
      if (!d.vendorId || !d.accountId || !d.environment)
        return blocked(
          "LISTING_INTENT_ACCOUNT_UNRESOLVED",
          "Review the store account connection before retrying.",
        );
      const repository = new PgDropshipListingPreviewRepository(this.pool);
      const receipt = await repository.findManagedIntentReceipt({
        vendorId: d.vendorId,
        storeConnectionId: d.connectionId,
        idempotencyKey: delivery.commandKey,
        productVariantIds: delivery.variantIds,
        accountId: d.accountId,
        environment: d.environment,
      });
      if (!receipt?.admitted) {
        const disposition = await this.lifecycle.assess(delivery);
        if (disposition) return disposition;
      }
      if (receipt && !receipt.admitted)
        return blocked(
          "DROPSHIP_LISTING_PREVIEW_BLOCKED",
          "The saved change could not be queued because its listing preview has blockers. Open the store listing workspace to review them.",
        );
      if (receipt)
        return {
          state: "delivered",
          receipt: {
            owner: "dropship_listing_push",
            operationId: String(receipt.jobId),
            commandKey: delivery.commandKey,
          },
        };
      if (delivery.variantIds.length > 500)
        return {
          state: "needs_review",
          code: "LISTING_INTENT_SCOPE_TOO_LARGE",
          message:
            "Review this product in the store listing workspace; its managed size set exceeds one supported listing update.",
        };
      const result = await this.dropship.createListingPushJob(
        {
          vendorId: d.vendorId,
          storeConnectionId: d.connectionId,
          productVariantIds: delivery.variantIds,
          reviewMode: "current_preview",
          idempotencyKey: delivery.commandKey,
          requestedRetailPricesByVariantId: {},
          requestedBy: { actorType: "system", actorId: ACTOR },
        },
        {
          accountId: d.accountId,
          environment: d.environment,
          managedOnly: true,
        },
      );
      if (result.preview.summary.ready + result.preview.summary.warning === 0)
        return blocked(
          "DROPSHIP_LISTING_PREVIEW_BLOCKED",
          "The saved change could not be queued because its listing preview has blockers. Open the store listing workspace to review them.",
        );
      return {
        state: "delivered",
        receipt: {
          owner: "dropship_listing_push",
          operationId: String(result.job.jobId),
          commandKey: delivery.commandKey,
        },
      };
    }
    const disposition = await this.lifecycle.assess(delivery);
    if (disposition) return disposition;
    return {
      state: "needs_review",
      code: "LISTING_INTENT_REVIEW_REQUIRED",
      message:
        "This saved change requires a review in the channel listing workspace. Automatic content maintenance is not supported for this connection.",
    };
  }
}
