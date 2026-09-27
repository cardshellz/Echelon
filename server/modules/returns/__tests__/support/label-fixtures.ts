import type {
  CustomerReturnLabelSettings,
  CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import type { ReturnPolicySnapshot } from "../../domain/return-case";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import {
  LIVE_NOW,
  addLiveOriginalBox,
  liveLocalFixture,
  liveShop,
  liveShopifyFixture,
} from "./live-inspection-fixtures";

export const LABEL_KEY = "b72c305a-30c6-43fd-9080-5999bfc4bd8f";
export const LABEL_LEASE = "60a34b88-cbcb-4f73-b315-a5d14cce35fc";
export const labelAddress = {
  name: "Test Warehouse",
  addressLine1: "1 Test Street",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  countryCode: "US" as const,
};
export const labelSettings: CustomerReturnLabelSettings = {
  version: 1,
  enabled: true,
  warehouseId: 1,
  policyId: 1,
  carrierId: "se-123",
  serviceCode: "ups_ground",
  contactName: "Test Warehouse",
  contactPhone: null,
  destinationAddress: labelAddress,
};
export const labelPolicy: ReturnPolicySnapshot = {
  id: 1,
  name: "Domestic returns",
  version: 1,
  scopeKind: "business_context",
  scopeKey: "retail",
  returnWindowDays: 365,
  returnDestination: "card_shellz",
  approvalAuthority: "card_shellz",
  labelProvider: "shipstation",
  returnShippingPayer: "card_shellz",
  inspectionRequirement: "required",
  inspectionOwner: "card_shellz",
  customerRefundAuthority: "card_shellz",
  vendorSettlementTrigger: "none",
  returnlessRefundAllowed: false,
};

export function labelSources() {
  const local = liveLocalFixture();
  const shopify = liveShopifyFixture();
  addLiveOriginalBox(local);
  shopify.order.shippingAddress = {
    name: "Synthetic Customer",
    phone: null,
    company: null,
    address1: "2 Test Road",
    address2: null,
    city: "Austin",
    provinceCode: "TX",
    zip: "78702",
    countryCodeV2: "US",
  };
  local.fulfillmentBindings = local.packageItems.map((item, index) => ({
    kind: "receipt",
    bindingId: index + 1,
    parentId: 1,
    provider: "shopify",
    sourceChannelId: 36,
    sourceOrderId: "1001",
    fulfillmentId: index === 0 ? "601" : "603",
    providerFulfillmentLineId: index === 0 ? "501" : "502",
    purchasedLineId: index === 0 ? "501" : "502",
    omsOrderLineId: item.omsOrderLineId,
    wmsOrderItemId: item.wmsOrderItemId,
    physicalShipmentId: item.physicalShipmentId,
    physicalShipmentItemId: item.physicalShipmentItemId,
    quantity: item.originalQuantity,
    status: "processed",
    source: "webhook",
  }));
  const service = new CustomerReturnLiveService({
    local: {
      listShops: async () => [liveShop],
      read: async () => structuredClone(local),
    },
    shopify: { read: async () => structuredClone(shopify) },
    dimensions: {
      read: async () => ({ lengthMm: 300, widthMm: 200, heightMm: 100 }),
    },
    now: () => new Date(LIVE_NOW),
  });
  return { local, shopify, service };
}
export async function labelPreparationFixture() {
  const sources = labelSources();
  const lookup = { channelId: 36, orderReference: "0012-A" };
  const inspection = await sources.service.inspectForIntake(lookup);
  const [first, second] = inspection.order.lines;
  const dimensions = { lengthMm: 300, widthMm: 200, heightMm: 100 };
  const input: CustomerReturnLabelSubmitInput = {
    ...lookup,
    sourceRevision: inspection.order.sourceRevision,
    idempotencyKey: LABEL_KEY,
    settingsVersion: 1,
    selections: [
      { lineId: first.id, quantity: 2, reasonCode: null },
      { lineId: second.id, quantity: 1, reasonCode: null },
    ],
    parcels: [
      {
        dimensions,
        originalBoxId: null,
        items: [
          { lineId: first.id, quantity: 1 },
          { lineId: second.id, quantity: 1 },
        ],
      },
      {
        dimensions,
        originalBoxId: null,
        items: [{ lineId: first.id, quantity: 1 }],
      },
    ],
  };
  return { ...sources, inspection, input };
}
