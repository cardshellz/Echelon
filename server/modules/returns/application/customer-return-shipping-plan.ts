import Decimal from "decimal.js";
import { customerReturnLabelAddressSchema, customerReturnWarehouseAddressTypeSchema,
  DEFAULT_RETURN_WAREHOUSE_ADDRESS_TYPE, type CustomerReturnLabelSettings } from "@shared/returns/customer-return-label.contract";
import type { CustomerReturnDimensions } from "@shared/returns/customer-return-parcel";
import { MILLIMETERS_PER_INCH, DIMENSION_INCH_DECIMAL_PLACES } from "@shared/shipping/dimensions";
import { returnRateShipmentSchema } from "../../shipping-engine/application/return-rate-provider.port";
import type { CustomerReturnShopifySnapshot } from "./customer-return-shopify-snapshot.ports";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";

const Exact = Decimal.clone({ precision: 40 });
export function customerReturnWarehouseAddressType(value: unknown) {
  return customerReturnWarehouseAddressTypeSchema.parse(value === undefined ? DEFAULT_RETURN_WAREHOUSE_ADDRESS_TYPE : value);
}
export function customerReturnProviderDimensions(dimensions: CustomerReturnDimensions) {
  const inches = (millimeters: number) => new Exact(millimeters).div(MILLIMETERS_PER_INCH)
    .toDecimalPlaces(DIMENSION_INCH_DECIMAL_PLACES, Decimal.ROUND_CEIL).toNumber();
  return { length: inches(dimensions.lengthMm), width: inches(dimensions.widthMm), height: inches(dimensions.heightMm) };
}
export function customerReturnOriginAddress(source: CustomerReturnShopifySnapshot["order"]["shippingAddress"]) {
  const origin = customerReturnLabelAddressSchema.safeParse(source && {
    name: source.name, ...(source.phone?.trim() ? { phone: source.phone } : {}),
    ...(source.company?.trim() ? { companyName: source.company } : {}), addressLine1: source.address1,
    ...(source.address2?.trim() ? { addressLine2: source.address2 } : {}),
    city: source.city, state: source.provinceCode, postalCode: source.zip, countryCode: source.countryCodeV2,
  });
  if (!origin.success) throw new CustomerReturnIntakeError("RETURN_LABEL_ORIGIN_UNVERIFIED",
    "The order's return shipping address needs verification before labels can be created.");
  return origin.data;
}
export function customerReturnPreflightShipments(
  origin: ReturnType<typeof customerReturnOriginAddress>, settings: CustomerReturnLabelSettings,
  parcels: readonly { weightGrams: number; dimensions: CustomerReturnDimensions }[],
) {
  return parcels.map((parcel, index) => returnRateShipmentSchema.parse({
    // Quick quotes do not persist provider shipments. These identifiers must never
    // be used for purchases; real purchases use the durable RMA/parcel identity.
    externalShipmentId: `echelon-return-preflight-${index + 1}`, rmaNumber: "RETURN-PREFLIGHT",
    shipFrom: origin, shipTo: { ...settings.destinationAddress, addressType: customerReturnWarehouseAddressType(settings.warehouseAddressType) },
    parcel: { weightGrams: parcel.weightGrams, dimensionsInches: customerReturnProviderDimensions(parcel.dimensions) },
  }));
}
