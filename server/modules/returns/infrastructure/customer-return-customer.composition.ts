import type { CustomerReturnCustomerSession } from "../application/customer-return-customer-auth.service";
import { CustomerReturnOrderAccessService } from "../application/customer-return-order-access.service";
import { PostgresCustomerReturnOrderAccessRepository } from "./customer-return-order-access.repository";
import { CustomerReturnCustomerOrdersService } from "../application/customer-return-customer-orders.service";
import { CustomerReturnCustomerOperationsService } from "../application/customer-return-customer-operations.service";
import { PostgresCustomerReturnCustomerOwnershipReader } from "./customer-return-customer-ownership.repository";
import { createCustomerReturnLiveService } from "./customer-return-live.composition";
import { createCustomerReturnLabelServices } from "./customer-return-label.composition";
import { PostgresCustomerReturnSettingsStore } from "./customer-return-label-settings.repository";

/** Call only after verifying the request's customer session. The private label
 * services stay behind the exact order/RMA/command ownership boundary. */
export async function createCustomerReturnCustomerServices(session: CustomerReturnCustomerSession) {
  const [{ pool, db }, live, internal] = await Promise.all([
    import("../../../db"), createCustomerReturnLiveService(), createCustomerReturnLabelServices(),
  ]);
  const principal = { channelId: session.channelId, externalCustomerId: session.externalCustomerId };
  const access = new CustomerReturnOrderAccessService({ channelId: principal.channelId,
    principalReader: { getVerifiedPrincipal: async () => ({ kind: "customer", ...principal }) },
    repository: new PostgresCustomerReturnOrderAccessRepository(pool) });
  const settings = new PostgresCustomerReturnSettingsStore(db);
  return {
    orders: new CustomerReturnCustomerOrdersService({ principal, access, live,
      reportUnavailableOrder: (context) => console.warn(JSON.stringify({
        event: "return_customer_order_unavailable", code: "RETURN_ORDER_INSPECTION_UNAVAILABLE", ...context,
      })),
      shippingVersion: async () => {
        const [current, control] = await Promise.all([settings.read(principal.channelId), settings.readControl(principal.channelId)]);
        return current?.enabled && !control.paused ? current.version : null;
      } }),
    operations: new CustomerReturnCustomerOperationsService({ principal, orderAccess: access,
      ownership: new PostgresCustomerReturnCustomerOwnershipReader(pool),
      submissions: internal.submissions, labels: internal.labels }),
    download: internal.download,
  };
}
