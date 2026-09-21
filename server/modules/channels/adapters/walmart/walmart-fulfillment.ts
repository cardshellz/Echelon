import { z } from "zod";
import type { ChannelFulfillmentProviderCommandInput } from "../../../oms/fulfillment-push.service";
import { providerCommandInput, type ChannelFulfillmentProviderExecutor } from "../../../oms/channel-fulfillment-authority.service";
import { ChannelFulfillmentProviderError } from "../../channel-fulfillment-provider.error";
import { WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";
import { validateWalmartOrderScope } from "./walmart-order.domain";
import type { WalmartOrder } from "./walmart-us-api";

type FulfillmentInput = Pick<ChannelFulfillmentProviderCommandInput, "omsOrderId" | "trackingNumber" | "carrier" | "shippedAt" | "items" | "notifyCustomer" | "trackingReplacement">;
const carriers: Readonly<Record<string, string>> = { ups: "UPS", usps: "USPS", fedex: "FedEx", dhl: "DHL", ontrac: "OnTrac" };
const method = z.enum(["Standard", "Express", "OneDay", "WhiteGlove", "Value", "Freight"]);

/** Read provider state before every attempt, including recovery from an ambiguous POST. */
export function prepareWalmartShipment(order: WalmartOrder, input: FulfillmentInput): { alreadySatisfied: boolean; body: unknown } {
  if (input.notifyCustomer === false || input.trackingReplacement) throw new WalmartApiError("WALMART_SHIPMENT_REVIEW", "Silent fulfillment and tracking amendments require review", false);
  const tracking = z.string().trim().min(1).max(100).safeParse(input.trackingNumber);
  const carrier = carriers[String(input.carrier).trim().toLowerCase()];
  const shippingMethod = method.safeParse(order.shippingInfo.methodCode);
  const shippedAt = input.shippedAt instanceof Date ? input.shippedAt.getTime() : NaN;
  if (!tracking.success || !carrier || !shippingMethod.success || !Number.isSafeInteger(shippedAt) || shippedAt <= 0) {
    throw new WalmartApiError("WALMART_TRACKING_INVALID", "Provide a supported carrier, tracking number, shipping method and persisted shipment date", false);
  }
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new WalmartApiError("WALMART_SHIPMENT_QUANTITY_INVALID", "Shipment quantities must be positive integers", false);
    quantities.set(item.channelOrderLineId, (quantities.get(item.channelOrderLineId) ?? 0) + item.quantity);
  }
  if (!quantities.size) throw new WalmartApiError("WALMART_SHIPMENT_EMPTY", "A shipment must include exact order lines", false);
  let satisfied = 0;
  const lines = [...quantities].map(([lineNumber, amount]) => {
    const line = order.orderLines.orderLine.find(line => line.lineNumber === lineNumber);
    if (!line || line.orderLineQuantity.amount !== 1 || amount !== 1) throw new WalmartApiError("WALMART_SHIPMENT_LINE_MISMATCH", "Shipment must match the supported Walmart line quantity", false);
    const states = line.orderLineStatuses.orderLineStatus;
    const matched = states.filter(state => ["Shipped", "Delivered"].includes(state.status)
      && state.trackingInfo?.trackingNumber === tracking.data
      && state.trackingInfo?.carrierName?.carrier?.toLowerCase() === carrier.toLowerCase())
      .reduce((sum, state) => sum + state.statusQuantity.amount, 0);
    if (matched === amount) satisfied++;
    else if (states.some(state => state.status !== "Acknowledged")) {
      throw new WalmartApiError("WALMART_SHIPMENT_STATE_CONFLICT", "Walmart line is cancelled, unacknowledged or shipped with different tracking", false);
    }
    return { lineNumber, sellerOrderId: String(input.omsOrderId), sellerOrderNo: String(input.omsOrderId), orderLineStatuses: { orderLineStatus: [{
      status: "Shipped", statusQuantity: { unitOfMeasurement: "EACH", amount: String(amount) },
      trackingInfo: { shipDateTime: shippedAt, carrierName: { carrier }, methodCode: shippingMethod.data, trackingNumber: tracking.data },
    }] } };
  });
  // A partial provider response is reviewable; resending the complete package
  // could duplicate units already accepted under a different shipment.
  if (satisfied > 0 && satisfied !== lines.length) throw new WalmartApiError("WALMART_PARTIAL_SHIPMENT_REVIEW", "Walmart has confirmed only part of this shipment", false);
  return { alreadySatisfied: satisfied === lines.length, body: { orderShipment: { orderLines: { orderLine: lines } } } };
}

export function createWalmartFulfillmentExecutor(channels: WalmartChannelService,
  prepare: (input: ChannelFulfillmentProviderCommandInput) => Promise<{ channelId: number; externalOrderId: string }>,
  fallback: ChannelFulfillmentProviderExecutor): ChannelFulfillmentProviderExecutor {
  return { async execute(command) {
    if (command.channelProvider !== "walmart") return fallback.execute(command);
    try {
      const input = providerCommandInput(command);
      const target = await prepare(input);
      return await channels.repository.withLock(target.channelId, async () => {
        const confirmed = await prepare(input);
        if (target.channelId !== confirmed.channelId || target.externalOrderId !== confirmed.externalOrderId) {
          throw new WalmartApiError("WALMART_SHIPMENT_IDENTITY_CHANGED", "Shipment order identity changed", false);
        }
        const connection = await channels.connection(target.channelId);
        channels.requireRuntime(connection);
        const api = channels.api(connection);
        const order = await api.order(target.externalOrderId);
        validateWalmartOrderScope(order, connection.ship_node_id);
        const request = prepareWalmartShipment(order, input);
        if (!request.alreadySatisfied) {
          await api.ship(target.externalOrderId, request.body);
          const readback = await api.order(target.externalOrderId);
          validateWalmartOrderScope(readback, connection.ship_node_id);
          if (!prepareWalmartShipment(readback, input).alreadySatisfied) throw new WalmartApiError("WALMART_SHIPMENT_UNCONFIRMED", "Walmart has not confirmed this shipment", true);
        }
        return { outcome: request.alreadySatisfied ? "ignored" as const : "success" as const,
          providerResponseId: target.externalOrderId, metadata: { trackingNumber: input.trackingNumber, shipNode: connection.ship_node_id } };
      });
    } catch (error) {
      if (error instanceof WalmartApiError) throw new ChannelFulfillmentProviderError(error.code, error.message, error.retryable ? "transient" : "permanent");
      throw error;
    }
  } };
}
