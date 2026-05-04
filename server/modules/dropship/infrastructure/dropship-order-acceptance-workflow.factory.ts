import {
  DropshipOrderAcceptanceWorkflowService,
  makeDropshipOrderAcceptanceWorkflowLogger,
} from "../application/dropship-order-acceptance-workflow-service";
import { getDropshipFulfillmentSync } from "./dropship-fulfillment-sync.registry";
import { createDropshipOrderAcceptanceServiceFromEnv } from "./dropship-order-acceptance.factory";
import { PgDropshipOrderAcceptanceWorkflowRepository } from "./dropship-order-acceptance-workflow.repository";
import { createDropshipShippingQuoteServiceFromEnv } from "./dropship-shipping-quote.factory";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";

export function createDropshipOrderAcceptanceWorkflowServiceFromEnv(): DropshipOrderAcceptanceWorkflowService {
  return new DropshipOrderAcceptanceWorkflowService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipOrderAcceptanceWorkflowRepository(),
    shippingQuoteService: createDropshipShippingQuoteServiceFromEnv(),
    acceptanceService: createDropshipOrderAcceptanceServiceFromEnv(),
    fulfillmentSync: getDropshipFulfillmentSync(),
    logger: makeDropshipOrderAcceptanceWorkflowLogger(),
  });
}
