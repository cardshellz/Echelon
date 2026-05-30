import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogContext {
  correlationId: string;
  omsOrderId?: number | string;
  wmsOrderId?: number;
  shipmentId?: number;
  channelEventId?: string;
  engineRef?: string;
}

const als = new AsyncLocalStorage<LogContext>();

export function getContext(): LogContext | undefined {
  return als.getStore();
}

export function runWithContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  const full: LogContext = {
    correlationId: ctx.correlationId ?? randomUUID(),
    ...ctx,
  };
  return als.run(full, fn);
}

export function bindContext(ctx: Partial<LogContext>): LogContext {
  const full: LogContext = {
    correlationId: ctx.correlationId ?? randomUUID(),
    ...ctx,
  };
  return full;
}

export function enrichContext(extra: Partial<Omit<LogContext, "correlationId">>): void {
  const store = als.getStore();
  if (store) {
    Object.assign(store, extra);
  }
}
