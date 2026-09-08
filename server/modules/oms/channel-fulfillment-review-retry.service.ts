import {
  ChannelFulfillmentReviewRetryError,
  reviewRetryInputSchema,
  type ChannelFulfillmentReviewRetryResult,
} from "./channel-fulfillment-review-retry.domain";
import type { ChannelFulfillmentReviewRetryRepository } from "./channel-fulfillment-review-retry.repository";

export interface ChannelFulfillmentReviewRetryService {
  review(input: unknown, actor: string): Promise<ChannelFulfillmentReviewRetryResult>;
}

export function createChannelFulfillmentReviewRetryService(dependencies: {
  readonly repository: ChannelFulfillmentReviewRetryRepository;
  readonly clock: { now(): Date };
}): ChannelFulfillmentReviewRetryService {
  return {
    async review(rawInput, actor) {
      const parsed = reviewRetryInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ChannelFulfillmentReviewRetryError(
          "INVALID_REVIEW_RETRY_INPUT", "Invalid reviewed command retry input", 400,
          { issues: parsed.error.issues },
        );
      }
      const input = parsed.data;
      const scope = { commandId: input.commandId, omsOrderId: input.omsOrderId };
      if (input.previewOnly) {
        return Object.freeze({
          ...await dependencies.repository.preview(scope),
          mode: "preview" as const,
          replayed: false,
          requeued: false,
        });
      }
      return dependencies.repository.requeue({
        ...scope,
        expectedStateFingerprint: input.expectedStateFingerprint!,
        reason: input.reason!,
        actor,
        requeuedAt: dependencies.clock.now(),
      });
    },
  };
}
