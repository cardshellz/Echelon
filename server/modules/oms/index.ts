export * from "./dropship-order-authority.api";
export * from "./order-linkage-sql.api";
export * from "./order-edit-coordination.api";
export * from "./webhook-retry.api";
export * from "./channel-order-intake.api";
export * from "./shopify-intake.api";
export * from "./channel-fulfillment-authority.api";
export * from "./shipstation-execution.api";
export * from "./operations-observability.api";

export interface OmsApi {
  readonly oms: import("./channel-order-intake.api").OmsService;
  readonly wmsSync: import("./channel-order-intake.api").WmsSyncService;
  readonly shipStation: import("./shipstation-execution.api").ShipStationService;
  readonly channelFulfillmentAuthority: import("./channel-fulfillment-authority.api").ChannelFulfillmentAuthorityService;
}
