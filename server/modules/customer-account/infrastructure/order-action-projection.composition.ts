import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { customerReturnCustomerOrderSchema } from "@shared/returns/customer-return-access.contract";
import type { OrderEditService } from "../../order-edits/application/order-edit.service";
import { CustomerOrderEditService } from "../application/customer-order-edit.service";
import { CustomerReturnOrderAccessService } from "../../returns/application/customer-return-order-access.service";
import { PostgresCustomerReturnOrderAccessRepository } from "../../returns/infrastructure/customer-return-order-access.repository";
import { PostgresOrderEditStore } from "../../order-edits/infrastructure/postgres-order-edit.store";
import { createCustomerReturnLiveService } from "../../returns/infrastructure/customer-return-live.composition";
import { PostgresCustomerReturnBoxMeasurements } from "../../returns/infrastructure/customer-return-box-measurements.repository";
import { PostgresCustomerReturnSettingsStore } from "../../returns/infrastructure/customer-return-label-settings.repository";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import { OrderActionProjectionWorker } from "../application/order-action-projection.worker";
import { OrderActionProjectionInspectorService } from "../application/order-action-projection.inspector";
import type { OrderActionScope } from "../application/order-action-projection.ports";
import { PostgresOrderActionProjectionStore } from "./order-action-projection.repository";
import { readCustomerAccountStagingConfig } from "../domain/customer-account-staging";

export type OrderActionProjectionReport = (event: {
  action: string; outcome: string; omsOrderId?: number; code?: string; durationMs?: number;
}) => void;
const SWEEP_INTERVAL_MS = 5_000;

export function createOrderActionProjectionWorker(pool: Pool, edits: OrderEditService, report: OrderActionProjectionReport) {
  const store = new PostgresOrderEditStore(pool);
  const config = readCustomerAccountStagingConfig(process.env.CUSTOMER_ACCOUNT_STAGING_CONFIG);
  const shopDomains = Object.entries(config?.shops ?? {}).filter(([, shop]) => shop.enabled).map(([domain]) => domain);
  const measurements = new PostgresCustomerReturnBoxMeasurements(pool);
  const now = () => new Date();
  const context = async (scope: OrderActionScope) => {
    const connection = await store.settings(scope.connectionId);
    if (connection.channelId !== scope.channelId) throw new OrderEditError("ORDER_ACTION_CONNECTION_CHANGED", "The order connection changed.", 409);
    const principal = { channelId: scope.channelId, externalCustomerId: scope.externalCustomerId, shopDomain: connection.shopDomain };
    const access = new CustomerReturnOrderAccessService({ channelId: scope.channelId,
      principalReader: { getVerifiedPrincipal: async () => ({ kind: "customer", channelId: scope.channelId, externalCustomerId: scope.externalCustomerId }) },
      repository: new PostgresCustomerReturnOrderAccessRepository(pool) });
    return { access, edits: new CustomerOrderEditService({ principal, access, store, edits }) };
  };
  const inspector = new OrderActionProjectionInspectorService({ report,
    readEdit: async scope => (await context(scope)).edits.order(scope.connectionId, scope.omsOrderId, "v1"),
    inspectReturnAndRetainMeasurements: async scope => {
      const { access } = await context(scope);
      const owned = await access.resolveOwned({ omsOrderId: scope.omsOrderId });
      if (owned.externalOrderId.replace(/^gid:\/\/shopify\/Order\//, "") !== scope.externalOrderId)
        throw new OrderEditError("ORDER_ACTION_IDENTITY_CHANGED", "The order identity changed.", 409);
      const live = await createCustomerReturnLiveService();
      const inspection = await live.inspectCanonicalForIntake({ channelId: scope.channelId, omsOrderId: owned.omsOrderId,
        externalOrderId: owned.externalOrderId, externalCustomerId: scope.externalCustomerId });
      const { mode: _mode, ...fields } = inspection.order;
      const { db } = await import("../../../db");
      const settingsVersion = await new PostgresCustomerReturnSettingsStore(db).customerVersion(scope.channelId);
      const result = customerReturnCustomerOrderSchema.parse({ omsOrderId: scope.omsOrderId, order: fields, settingsVersion });
      await measurements.retain(inspection.local, fields.boxOptions, now());
      return result;
    },
  });
  return new OrderActionProjectionWorker({ store: new PostgresOrderActionProjectionStore(pool, shopDomains), now, newId: randomUUID, report, inspector });
}

/** Read-model maintenance only: no order/points/label command or recovery worker. */
export function startOrderActionProjectionScheduler(worker: Pick<OrderActionProjectionWorker, "run">, report: OrderActionProjectionReport): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await worker.run(); }
    catch { report({ action: "order_action_projection_sweep", outcome: "failed", code: "ORDER_ACTION_SWEEP_FAILED" }); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, SWEEP_INTERVAL_MS);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
