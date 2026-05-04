import type {
  DropshipLogger,
  DropshipOmsFulfillmentSync,
} from "./dropship-ports";
import type { DropshipOrderAcceptanceResult } from "./dropship-order-acceptance-service";

export interface SyncDropshipAcceptedOrderToWmsInput {
  acceptance: Pick<
    DropshipOrderAcceptanceResult,
    "outcome" | "intakeId" | "vendorId" | "storeConnectionId" | "omsOrderId" | "idempotentReplay"
  >;
  source: "order_processing" | "vendor_acceptance";
}

export async function syncDropshipAcceptedOrderToWmsSafely(
  deps: {
    fulfillmentSync?: DropshipOmsFulfillmentSync;
    logger: DropshipLogger;
  },
  input: SyncDropshipAcceptedOrderToWmsInput,
): Promise<void> {
  if (input.acceptance.outcome !== "accepted") {
    return;
  }

  if (!deps.fulfillmentSync) {
    return;
  }

  const context = {
    intakeId: input.acceptance.intakeId,
    vendorId: input.acceptance.vendorId,
    storeConnectionId: input.acceptance.storeConnectionId,
    omsOrderId: input.acceptance.omsOrderId,
    idempotentReplay: input.acceptance.idempotentReplay,
    source: input.source,
  };

  if (!input.acceptance.omsOrderId) {
    deps.logger.warn({
      code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_SKIPPED",
      message: "Accepted dropship order could not be synced to WMS because no OMS order id was returned.",
      context: {
        ...context,
        reason: "missing_oms_order_id",
      },
    });
    return;
  }

  try {
    const wmsOrderId = await deps.fulfillmentSync.syncOmsOrderToWms(input.acceptance.omsOrderId);
    if (wmsOrderId === null) {
      deps.logger.warn({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_UNRESOLVED",
        message: "Accepted dropship order did not return a WMS order id during OMS to WMS sync.",
        context,
      });
      return;
    }

    deps.logger.info({
      code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNCED",
      message: "Accepted dropship order was synced from OMS to WMS.",
      context: {
        ...context,
        wmsOrderId,
      },
    });
  } catch (error) {
    deps.logger.error({
      code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNC_FAILED",
      message: "Accepted dropship order failed during OMS to WMS sync.",
      context: {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
