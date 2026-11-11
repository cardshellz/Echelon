export {
  resolveRuntimeChannelShipping,
  type RuntimeChannelShippingResolution,
} from "./application/channel-shipping-policy-runtime.service";

export type { ShipmentParcelProvider } from "./application/shipment-parcel-provider";

export {
  quoteShipment,
  type ShipmentQuoteRequest,
  type ShipmentQuoteResult,
} from "./application/shipment-quote.service";

export type { ShippingQuoteEvidenceWriter } from "./application/shipping-quote-evidence-writer";

export {
  localRateTableShippingRateProvider,
  type ShippingRateProvider,
} from "./application/shipping-rate-provider";

export type { ProductRateTraceStep } from "./domain/product-rate-policy";

export { selectRateBookAssignment } from "./domain/rate-book";

export type {
  ShippingFulfillmentMode,
  ShippingPricingBasis,
  ShippingRateChargeModel,
} from "./domain/rate-selection";

export type {
  ShipmentLineInput,
  ShipmentParcelPlan,
} from "./domain/shipment";

export {
  loadCatalogShippingFactsByVariantIds,
  type CatalogShippingFactByVariant,
} from "./infrastructure/catalog-weight.repository";

export { PostgresChannelShippingPolicyRuntimeStore } from "./infrastructure/channel-shipping-policy-runtime.repository";

export { PostgresShippingQuoteEvidenceWriter } from "./infrastructure/postgres-shipping-quote-evidence.writer";
