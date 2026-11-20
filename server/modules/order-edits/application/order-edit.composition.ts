import { createOrderEditCredentialStore } from "../infrastructure/order-edit-credential-store";
import { PostgresAccountNativeSummaries } from "../../customer-account/shopify-account-native.api";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ServiceRegistry } from "../../../services";
import { OrderEditService } from "./order-edit.service";
import { PostgresOrderEditStore } from "../infrastructure/postgres-order-edit.store";
import { ShopifyOrderEditProvider } from "../infrastructure/shopify-order-edit.provider";
import { OrderEditWarehouseGateway } from "../infrastructure/order-edit-warehouse.gateway";
import { OrderEditOmsSynchronizer } from "../infrastructure/order-edit-oms-synchronizer";
import { OrderEditPaidProjection } from "../../oms/order-edit-coordination.api";
import { OrderEditPreviewService } from "./order-edit-preview.service";
import { createMemberPlanPresentationReader } from "../../membership";
import { ClubOrderEditCodeRedemptions } from "../infrastructure/club-order-edit-code-redemptions";
import { PostgresOrderEditCodeHistory } from "../infrastructure/postgres-order-edit-code-history";
import { OrderCancellationService } from "../../customer-account/order-cancellation-contracts.api";

export function createOrderEditService(
  pool: Pool,
  services: Pick<ServiceRegistry, "shippingEngine" | "wmsSync" | "reservation"> &
    Partial<Pick<ServiceRegistry, "shipStation">>,
): OrderEditService {
  const clock = () => new Date();
  const codeRedemptions = new ClubOrderEditCodeRedemptions(
    process.env.SHELLZ_CLUB_API_URL,
    process.env.INTERNAL_API_KEY,
  );
  const provider = new ShopifyOrderEditProvider({
    clock,
    rewards: codeRedemptions,
    codeHistory: new PostgresOrderEditCodeHistory(pool),
    memberPresentation: createMemberPlanPresentationReader(pool),
    report: (event) =>
      console.error(
        JSON.stringify({
          event: "order_edit_quote_preflight_failure",
          ...event,
        }),
      ),
    credentials: createOrderEditCredentialStore(pool, clock),
    accountSummaries: new PostgresAccountNativeSummaries(pool),
    reportAccountSummaryFailure: (error) =>
      console.error(
        JSON.stringify({ event: "account_native_retain_failed", error }),
      ),
  });
  const paidProjection = new OrderEditPaidProjection(pool, clock);
  const synchronize = new OrderEditOmsSynchronizer(
    pool,
    services.wmsSync,
    services.reservation,
    (orderId, operationId, snapshot) =>
      paidProjection.project(orderId, operationId, snapshot),
  );
  const store = new PostgresOrderEditStore(pool);
  const warehouseProvider = services.shippingEngine?.synchronizeOrderEditShipment
    ? {
        isConfigured: () => services.shippingEngine.isConfigured(),
        synchronizeOrderEditShipment: (input: Parameters<NonNullable<ServiceRegistry["shippingEngine"]["synchronizeOrderEditShipment"]>>[0]) =>
          services.shippingEngine.synchronizeOrderEditShipment!(input),
      }
    : services.shipStation!;
  const warehouse = new OrderEditWarehouseGateway(
    pool,
    warehouseProvider,
    (id, snapshot, operationId) =>
      synchronize.synchronize(id, snapshot, operationId),
    clock,
  );
  return new OrderEditService(
    store,
    provider,
    warehouse,
    clock,
    randomUUID,
    (event) =>
      console.error(
        JSON.stringify({ event: "order_edit_requires_attention", ...event }),
      ),
    new OrderEditPreviewService(store, provider, warehouse, clock),
    provider.catalog,
    codeRedemptions,
    new OrderCancellationService({
      store,
      provider,
      warehouse,
      rewards: codeRedemptions,
      clock,
      uuid: randomUUID,
      report: (event) =>
        console.error(
          JSON.stringify({
            event: "customer_order_cancellation_pending",
            ...event,
          }),
        ),
    }),
  );
}
