import { z } from "zod";
import { CarrierTrackingPayloadError } from "./carrier-tracking.domain";
import { normalizeSavedLabelStatusObservation } from "./saved-label-status.domain";
import {
  SavedLabelStatusSourceError,
  type SavedLabelStatusSourceReader,
} from "./saved-label-status.source";
import type {
  SavedLabelStatusStore,
  SavedLabelStatusOutcome,
} from "./saved-label-status.repository";
import type { CarrierTrackingService } from "./carrier-tracking.service";
import {
  latestSalesChannelDeliveryEvidence,
  mergeDeliveryStatus,
  salesChannelDeliveryEvidenceSchema,
} from "./sales-channel-delivery.domain";
import type { SalesChannelDeliveryEvidenceStore } from "./sales-channel-delivery.repository";

const ACTIVE_POLL_MS = 6 * 60 * 60_000;
/** Lease fencing and immutable attempts make retries safe. Capture performs
 * provider GETs and shipping-owned status writes, never buys or refunds. */
export class SavedLabelStatusWorker {
  constructor(
    private readonly dependencies: {
      store: SavedLabelStatusStore;
      source: SavedLabelStatusSourceReader;
      channelEvidence?: SalesChannelDeliveryEvidenceStore;
      tracking: Pick<
        CarrierTrackingService,
        "observeStatusLabel" | "ingestStatusSnapshot"
      >;
      now(): Date;
      newToken(): string;
      report(event: { code: string; jobId: number; attempt: number }): void;
    },
  ) {}
  async run(
    limit = 5,
  ): Promise<{ claimed: number; completed: number; errors: number }> {
    z.number().int().min(1).max(10).parse(limit);
    const claims = await this.dependencies.store.claim(
      limit,
      this.dependencies.now(),
      this.dependencies.newToken(),
    );
    const result = { claimed: claims.length, completed: 0, errors: 0 };
    for (const claim of claims) {
      let outcome: SavedLabelStatusOutcome;
      try {
        const source = {
          kind: claim.kind,
          sourceId: claim.sourceId,
          providerReference: claim.providerReference,
          trackingNumber: claim.trackingNumber,
        };
        const loaded = await this.dependencies.source.read(source);
        if ("finished" in loaded) {
          outcome = {
            state: "complete",
            code: null,
            status: "received",
            nextAttemptAt: null,
          };
        } else {
          const { facts, snapshot } = loaded;
          const channelEvidence = z
            .array(salesChannelDeliveryEvidenceSchema)
            .max(201)
            .parse(loaded.channelEvidence ?? []);
          if (channelEvidence.length) {
            if (
              source.kind !== "history" ||
              facts.direction !== "outbound" ||
              channelEvidence.some(
                (e) =>
                  e.omsOrderId !== source.sourceId ||
                  e.providerReference !== source.providerReference ||
                  e.trackingNumber !== source.trackingNumber ||
                  Date.parse(e.occurredAt) >
                    this.dependencies.now().getTime() ||
                  Date.parse(e.observedAt) > this.dependencies.now().getTime(),
              )
            ) {
              throw new SavedLabelStatusSourceError(
                "SAVED_LABEL_STATUS_CHANNEL_IDENTITY_MISMATCH",
                false,
              );
            }
            if (!this.dependencies.channelEvidence)
              throw new Error(
                "Shipping delivery evidence store is unavailable",
              );
            await this.dependencies.channelEvidence.append(channelEvidence);
          }
          await this.dependencies.tracking.observeStatusLabel(
            normalizeSavedLabelStatusObservation(
              source,
              facts,
              this.dependencies.now(),
            ),
          );
          const ingested =
            snapshot === null
              ? null
              : await this.dependencies.tracking.ingestStatusSnapshot(
                  snapshot,
                  {
                    providerLabelId: facts.providerReference,
                    carrierCode: facts.carrierCode,
                    trackingNumber: facts.trackingNumber,
                  },
                );
          const latestChannel =
            latestSalesChannelDeliveryEvidence(channelEvidence);
          const effectiveStatus = mergeDeliveryStatus(
            ingested?.matchStatus === "matched" &&
              (ingested.eventOccurredAt === null ||
                ingested.eventOccurredAt <= this.dependencies.now())
              ? {
                  status: ingested.canonicalStatus,
                  occurredAt: ingested.eventOccurredAt,
                }
              : null,
            latestChannel
              ? {
                  status: latestChannel.canonicalStatus,
                  occurredAt: new Date(latestChannel.occurredAt),
                }
              : null,
          );
          const delivered = effectiveStatus === "delivered";
          const complete = facts.voided || delivered;
          outcome = {
            state: complete ? "complete" : "active",
            code:
              ingested && ingested.matchStatus !== "matched"
                ? "SAVED_LABEL_STATUS_MATCH_UNRESOLVED"
                : null,
            status: facts.voided ? "voided" : delivered ? "delivered" : null,
            nextAttemptAt: complete
              ? null
              : new Date(this.dependencies.now().getTime() + ACTIVE_POLL_MS),
          };
        }
      } catch (error) {
        const invalid =
          error instanceof z.ZodError ||
          error instanceof CarrierTrackingPayloadError ||
          (error instanceof Error &&
            error.message.startsWith("SALES_CHANNEL_DELIVERY_")) ||
          (error instanceof Error &&
            [
              "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
              "SAVED_LABEL_STATUS_ALIAS_UNVERIFIED",
            ].includes(error.message));
        const retryable =
          !invalid &&
          (!(error instanceof SavedLabelStatusSourceError) || error.retryable);
        const code =
          error instanceof SavedLabelStatusSourceError
            ? error.code
            : invalid
              ? "SAVED_LABEL_STATUS_DATA_INVALID"
              : "SAVED_LABEL_STATUS_CAPTURE_FAILED";
        outcome = {
          state: retryable ? "retry" : "review",
          code,
          status: null,
          nextAttemptAt: retryable
            ? new Date(
                this.dependencies.now().getTime() +
                  Math.min(
                    ACTIVE_POLL_MS,
                    60_000 * 2 ** Math.min(claim.failures, 8),
                  ),
              )
            : null,
        };
        result.errors++;
        this.dependencies.report({
          code,
          jobId: claim.id,
          attempt: claim.attempt,
        });
      }
      const settled = await this.dependencies.store.settle(
        claim,
        outcome,
        this.dependencies.now(),
      );
      if (settled) result.completed++;
      else
        this.dependencies.report({
          code: "SAVED_LABEL_STATUS_LEASE_LOST",
          jobId: claim.id,
          attempt: claim.attempt,
        });
    }
    return result;
  }
}
