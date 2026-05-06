import { db as defaultDb } from "../../../db";
import { enqueueOmsWmsSyncRetry } from "../../oms/webhook-retry.worker";
import type { DropshipOmsFulfillmentSyncRetryQueue } from "../application/dropship-ports";

export class WebhookRetryDropshipFulfillmentSyncRetryQueue implements DropshipOmsFulfillmentSyncRetryQueue {
  constructor(private readonly dbHandle: unknown = defaultDb) {}

  async enqueueOmsWmsSyncRetry(input: {
    omsOrderId: number;
    cause?: unknown;
  }): Promise<void> {
    await enqueueOmsWmsSyncRetry(this.dbHandle, input.omsOrderId, input.cause);
  }
}

export function createDropshipFulfillmentSyncRetryQueueFromEnv(): DropshipOmsFulfillmentSyncRetryQueue {
  return new WebhookRetryDropshipFulfillmentSyncRetryQueue();
}
