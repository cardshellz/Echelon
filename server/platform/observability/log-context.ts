import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogContext {
  correlationId: string;
  correlation_id?: string;
  omsOrderId?: number | string;
  oms_order_id?: number | string;
  wmsOrderId?: number;
  wms_order_id?: number;
  shipmentId?: number;
  shipment_id?: number;
  channelEventId?: string;
  channel_event_id?: string;
  engineRef?: string;
  engine_ref?: string;
}

export type CorrelationEnrichment = Partial<Omit<LogContext, "correlationId">>;

const als = new AsyncLocalStorage<LogContext>();

function syncDualCorrelationKeys(target: Partial<LogContext>): void {
  const oms = target.omsOrderId ?? target.oms_order_id;
  if (oms !== undefined) {
    target.omsOrderId = oms;
    target.oms_order_id = oms;
  }
  const wms = target.wmsOrderId ?? target.wms_order_id;
  if (wms !== undefined) {
    target.wmsOrderId = wms;
    target.wms_order_id = wms;
  }
  const shp = target.shipmentId ?? target.shipment_id;
  if (shp !== undefined) {
    target.shipmentId = shp;
    target.shipment_id = shp;
  }
  const evt = target.channelEventId ?? target.channel_event_id;
  if (evt !== undefined) {
    target.channelEventId = evt;
    target.channel_event_id = evt;
  }
  const ref = target.engineRef ?? target.engine_ref;
  if (ref !== undefined) {
    target.engineRef = ref;
    target.engine_ref = ref;
  }
  if (target.correlationId) {
    target.correlation_id = target.correlationId;
  }
}

export function toCanonicalCorrelationFields(
  ctx: Partial<LogContext> | undefined,
): Record<string, unknown> {
  if (!ctx) return {};
  const fields: Record<string, unknown> = {};
  const correlationId = ctx.correlationId ?? ctx.correlation_id;
  if (correlationId !== undefined) {
    fields.correlationId = correlationId;
    fields.correlation_id = correlationId;
  }
  const omsOrderId = ctx.omsOrderId ?? ctx.oms_order_id;
  if (omsOrderId !== undefined) {
    fields.omsOrderId = omsOrderId;
    fields.oms_order_id = omsOrderId;
  }
  const wmsOrderId = ctx.wmsOrderId ?? ctx.wms_order_id;
  if (wmsOrderId !== undefined) {
    fields.wmsOrderId = wmsOrderId;
    fields.wms_order_id = wmsOrderId;
  }
  const shipmentId = ctx.shipmentId ?? ctx.shipment_id;
  if (shipmentId !== undefined) {
    fields.shipmentId = shipmentId;
    fields.shipment_id = shipmentId;
  }
  const channelEventId = ctx.channelEventId ?? ctx.channel_event_id;
  if (channelEventId !== undefined) {
    fields.channelEventId = channelEventId;
    fields.channel_event_id = channelEventId;
  }
  const engineRef = ctx.engineRef ?? ctx.engine_ref;
  if (engineRef !== undefined) {
    fields.engineRef = engineRef;
    fields.engine_ref = engineRef;
  }
  return fields;
}

export function getContext(): LogContext | undefined {
  return als.getStore();
}

export function bindContext(ctx: Partial<LogContext>): LogContext {
  const correlationId = ctx.correlationId ?? ctx.correlation_id ?? randomUUID();
  const full: LogContext = {
    ...ctx,
    correlationId,
    correlation_id: correlationId,
  };
  syncDualCorrelationKeys(full);
  return full;
}

export function runWithContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  const current = als.getStore();
  const merged = bindContext({
    ...(current ?? {}),
    ...ctx,
    correlationId:
      ctx.correlationId ??
      ctx.correlation_id ??
      current?.correlationId ??
      randomUUID(),
  });
  return als.run(merged, fn);
}

export function enrichContext(extra: CorrelationEnrichment): void {
  const store = als.getStore();
  if (store) {
    Object.assign(store, extra);
    syncDualCorrelationKeys(store);
  }
}
