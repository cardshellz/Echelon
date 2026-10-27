import { CustomerReturnLiveService } from "../application/customer-return-live.service";
import { CustomerReturnLiveError } from "../application/customer-return-live-error";
import { customerReturnShopifyDomainSchema } from "../application/customer-return-shopify-snapshot.ports";
import { PostgresCustomerReturnLocalInspectionReader } from "./customer-return-local-inspection.reader";
import { ShopifyCustomerReturnSnapshotReader } from "./customer-return-shopify-snapshot.reader";
import { createCustomerReturnShipStationDimensionsReader } from "./customer-return-shipstation-dimensions.reader";
import { PostgresCustomerReturnPortalPolicyReader } from "./customer-return-policy.reader";
import { PostgresCustomerReturnBoxMeasurements } from "./customer-return-box-measurements.repository";
import { createShipStationReturnRateAdapter } from "../../shipping-engine/infrastructure/shipstation-return-rate.adapter";
import { ShippingPackageDimensionsReader } from "../../shipping/package-dimensions.reader";

/** Explicit scope: neither the default channel nor a shop name/currency establishes the approved store. */
export function parseCustomerReturnShopDomains(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const domains = raw.split(",").map(value => value.trim());
  if (domains.length > 20 || domains.some(domain => !customerReturnShopifyDomainSchema.safeParse(domain).success)
    || new Set(domains).size !== domains.length) {
    throw new CustomerReturnLiveError("RETURN_LIVE_CONFIG_INVALID", "The returns store configuration needs attention.", 503);
  }
  return domains;
}

/** Called only after fresh administrator authorization. No boot-time provider request or mutation. */
export async function createCustomerReturnLiveService(): Promise<CustomerReturnLiveService> {
  const approvedShopDomains = parseCustomerReturnShopDomains(process.env.CUSTOMER_RETURN_SHOPIFY_DOMAINS);
  const [{ pool, db }, { ChannelIdentityService }] = await Promise.all([
    import("../../../db"), import("../../channels/channel-identity.service"),
  ]);
  const identity = new ChannelIdentityService(db);
  const storedDimensions = new ShippingPackageDimensionsReader(pool);
  const now = (): Date => new Date();
  return new CustomerReturnLiveService({
    policies: new PostgresCustomerReturnPortalPolicyReader(db),
    measurements: new PostgresCustomerReturnBoxMeasurements(pool),
    storedDimensions: { read: input => storedDimensions.read({ provider: "shipstation", ...input }) },
    rates: process.env.SHIPSTATION_V2_API_KEY?.trim() ? createShipStationReturnRateAdapter({ apiKey: process.env.SHIPSTATION_V2_API_KEY.trim() }) : undefined,
    local: new PostgresCustomerReturnLocalInspectionReader(pool, { approvedShopDomains, clock: now }),
    shopify: new ShopifyCustomerReturnSnapshotReader({ resolveConnection: channelId => identity.shopifyConnection(channelId), request: fetch, now }),
    dimensions: createCustomerReturnShipStationDimensionsReader({ apiKey: process.env.SHIPSTATION_API_KEY,
      apiSecret: process.env.SHIPSTATION_API_SECRET, request: fetch }),
    now,
  });
}
