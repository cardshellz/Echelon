import {
  ChannelFulfillmentReceiptRetryError,
  receiptRetryInputSchema,
  type ChannelFulfillmentReceiptRetryResult,
} from "./channel-fulfillment-receipt-retry.domain";
import type { ChannelFulfillmentReceiptRetryRepository } from "./channel-fulfillment-receipt-retry.repository";

export interface ChannelFulfillmentReceiptRetryService {
  review(input: unknown, actor: string): Promise<ChannelFulfillmentReceiptRetryResult>;
}

export function createChannelFulfillmentReceiptRetryService(dependencies: {
  readonly repository: ChannelFulfillmentReceiptRetryRepository;
  readonly clock: { now(): Date };
}): ChannelFulfillmentReceiptRetryService {
  return {
    async review(rawInput, actor) {
      const parsed = receiptRetryInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ChannelFulfillmentReceiptRetryError(
          "INVALID_RECEIPT_RETRY_INPUT",
          "Invalid channel fulfillment receipt retry input",
          400,
          { issues: parsed.error.issues },
        );
      }
      const input = parsed.data;
      const scope = { receiptId: input.receiptId };
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
        actor,
        reason: input.reason!,
        requeuedAt: dependencies.clock.now(),
      });
    },
  };
}
