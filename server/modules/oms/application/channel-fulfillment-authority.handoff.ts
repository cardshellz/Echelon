import { sql } from "drizzle-orm";

import type {
  ChannelFulfillmentAuthorityService,
  MaterializeAndDispatchResult,
} from "./channel-fulfillment-authority.service";

export const CHANNEL_FULFILLMENT_AUTHORITY_UNAVAILABLE =
  "CHANNEL_FULFILLMENT_AUTHORITY_UNAVAILABLE";
export const CHANNEL_FULFILLMENT_PHYSICAL_SHIPMENT_MISSING =
  "CHANNEL_FULFILLMENT_PHYSICAL_SHIPMENT_MISSING";

export class ChannelFulfillmentHandoffError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ChannelFulfillmentHandoffError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export interface ChannelFulfillmentHandoffSummary {
  readonly shipmentIds: readonly number[];
  readonly results: readonly MaterializeAndDispatchResult[];
  readonly commandCount: number;
  readonly terminalCommandCount: number;
  readonly complete: boolean;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ChannelFulfillmentHandoffError(
      "INVALID_INPUT",
      `${field} must be a positive integer`,
      { field, value },
    );
  }
  return parsed;
}

export function requireChannelFulfillmentAuthority(
  service: ChannelFulfillmentAuthorityService | null | undefined,
): ChannelFulfillmentAuthorityService {
  if (!service) {
    throw new ChannelFulfillmentHandoffError(
      CHANNEL_FULFILLMENT_AUTHORITY_UNAVAILABLE,
      "Canonical channel fulfillment authority is not initialized",
    );
  }
  return service as ChannelFulfillmentAuthorityService;
}

export function isChannelFulfillmentHandoffComplete(
  result: MaterializeAndDispatchResult,
): boolean {
  const commands = result.materialized.channelCommands;
  if (commands.length === 0) return false;

  const terminalBeforeDispatch = commands.filter(
    (command) => command.pushStatus === "success" || command.pushStatus === "ignored",
  ).length;
  const terminalDuringDispatch = result.dispatch.succeeded + result.dispatch.ignored;
  return terminalBeforeDispatch + terminalDuringDispatch === commands.length;
}

export async function handoffLegacyShipmentToChannelFulfillment(
  authority: ChannelFulfillmentAuthorityService,
  legacyWmsShipmentId: number,
  options: { readonly source: string; readonly executeImmediately?: boolean },
): Promise<MaterializeAndDispatchResult> {
  const shipmentId = positiveInteger(legacyWmsShipmentId, "legacyWmsShipmentId");
  const source = options.source.trim();
  if (!source) {
    throw new ChannelFulfillmentHandoffError(
      "INVALID_INPUT",
      "Channel fulfillment handoff source is required",
    );
  }

  return requireChannelFulfillmentAuthority(authority).ensureLegacyShipment(shipmentId, {
    executeImmediately: options.executeImmediately ?? true,
    source,
  });
}

export async function handoffOmsOrderShipmentsToChannelFulfillment(
  db: any,
  authority: ChannelFulfillmentAuthorityService,
  omsOrderId: number,
  options: { readonly source: string; readonly executeImmediately?: boolean },
): Promise<ChannelFulfillmentHandoffSummary> {
  const orderId = positiveInteger(omsOrderId, "omsOrderId");
  const result: any = await db.execute(sql`
    SELECT DISTINCT shipment.id AS shipment_id
    FROM wms.outbound_shipments AS shipment
    JOIN wms.orders AS wms_order
      ON wms_order.id = shipment.order_id
    WHERE wms_order.oms_fulfillment_order_id = ${String(orderId)}
      AND shipment.status = 'shipped'
      AND NULLIF(BTRIM(shipment.tracking_number), '') IS NOT NULL
    ORDER BY shipment.id ASC
  `);
  const shipmentIds = (result?.rows ?? [])
    .map((row: any) => positiveInteger(row.shipment_id, "shipmentId"));
  if (shipmentIds.length === 0) {
    throw new ChannelFulfillmentHandoffError(
      CHANNEL_FULFILLMENT_PHYSICAL_SHIPMENT_MISSING,
      `OMS order ${orderId} has no shipped WMS package with tracking`,
      { omsOrderId: orderId },
    );
  }

  const handoffResults: MaterializeAndDispatchResult[] = [];
  for (const shipmentId of shipmentIds) {
    handoffResults.push(await handoffLegacyShipmentToChannelFulfillment(
      authority,
      shipmentId,
      options,
    ));
  }

  const commandCount = handoffResults.reduce(
    (sum, handoff) => sum + handoff.materialized.channelCommands.length,
    0,
  );
  const terminalCommandCount = handoffResults.reduce((sum, handoff) => {
    const terminalBefore = handoff.materialized.channelCommands.filter(
      (command) => command.pushStatus === "success" || command.pushStatus === "ignored",
    ).length;
    return sum + terminalBefore + handoff.dispatch.succeeded + handoff.dispatch.ignored;
  }, 0);

  return Object.freeze({
    shipmentIds: Object.freeze([...shipmentIds]),
    results: Object.freeze([...handoffResults]),
    commandCount,
    terminalCommandCount,
    complete: commandCount > 0 && terminalCommandCount === commandCount,
  });
}
