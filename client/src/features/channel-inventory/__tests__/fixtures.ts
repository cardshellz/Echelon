import type {
  ChannelExposurePolicyHead,
  ChannelExposurePolicyScope,
  ChannelExposurePolicyValue,
} from "@shared/types/inventory-channel-exposure";

import type { PreviewRow, Target, View } from "../model";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const NOW = new Date("2026-09-15T12:00:00.000Z");

export function policyValue(overrides: Partial<ChannelExposurePolicyValue> = {}): ChannelExposurePolicyValue {
  return {
    allocationSemantics: null,
    eligible: null,
    shareBps: null,
    holdbackSellableUnits: null,
    maxPublish: null,
    minPublishSellableUnits: null,
    ...overrides,
  };
}

export function policyHead(input: {
  scopeKey: string;
  channelId: number;
  scope: ChannelExposurePolicyScope;
  active?: ChannelExposurePolicyValue | null;
  draft?: ChannelExposurePolicyValue | null;
  revision?: string;
}): ChannelExposurePolicyHead {
  const version = (value: ChannelExposurePolicyValue, lifecycle: "draft" | "sealed", policyId: number, hash: string) => ({
    policyId,
    version: policyId,
    lifecycleStatus: lifecycle,
    scope: input.scope,
    value,
    definitionHash: hash,
    changeReason: null,
    createdBy: "operator-1",
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
  });
  return {
    scopeKey: input.scopeKey,
    channelId: input.channelId,
    revision: input.revision ?? "1",
    activePolicy: input.active ? version(input.active, "sealed", 1, HASH_A) : null,
    draftPolicy: input.draft ? version(input.draft, "draft", 2, HASH_B) : null,
  };
}

export function target(overrides: Partial<Target> = {}): Target {
  return {
    id: 5,
    destinationKind: "channel_connection",
    channelId: 3,
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    legacyFulfillmentNodeId: 7,
    providerScopeType: "location",
    externalScopeId: "gid://shopify/Location/1",
    publicationAuthority: "echelon",
    state: "preview",
    revision: "3",
    ...overrides,
  };
}

export function view(overrides: Partial<View> = {}): View {
  return {
    products: [
      { id: 10, sku: "CARD", name: "Card Shell" },
      { id: 11, sku: "BOX", name: "Storage Box" },
    ],
    selectedProduct: {
      id: 10,
      sku: "CARD",
      name: "Card Shell",
      variants: [
        { id: 101, sku: "CARD-P5", name: "Pack of 5", unitsPerVariant: 5, salesEligibility: "sellable", isActive: true },
        { id: 102, sku: "CARD-EA", name: "Single", unitsPerVariant: 1, salesEligibility: "sellable", isActive: true },
        { id: 103, sku: "CARD-CMP", name: "Component", unitsPerVariant: 1, salesEligibility: "internal_only", isActive: true },
      ],
    },
    channels: [
      {
        id: 3,
        name: "Shopify US",
        provider: "shopify",
        status: "active",
        connections: [{ id: 33, externalAccountLabel: "us-store.myshopify.com", shopifyLocationId: "gid://shopify/Location/1", providerAccount: null }],
      },
      {
        id: 4,
        name: "eBay",
        provider: "ebay",
        status: "active",
        connections: [{
          id: 44,
          externalAccountLabel: "ebay-seller",
          shopifyLocationId: null,
          providerAccount: { externalAccountId: "ebay-user-9", displayName: "cardshellz", verifiedAt: "2026-09-01T00:00:00.000Z" },
        }],
      },
      { id: 6, name: "Amazon", provider: "amazon", status: "active", connections: [{ id: 66, externalAccountLabel: "amz", shopifyLocationId: null, providerAccount: null }] },
      // The single internal channel that hosts dropship storefronts.
      { id: 7, name: "Dropship OMS", provider: "manual", status: "active", connections: [] },
    ],
    dropshipDestinationChannelId: 7,
    dropshipStores: [
      { id: 90, vendorId: 1, vendorName: "Vendor Co", platform: "ebay", status: "connected", externalAccountLabel: "vendor-ebay", verifiedExternalAccountId: "vendor-user-1" },
      { id: 91, vendorId: 2, vendorName: "Tok Vendor", platform: "tiktok", status: "connected", externalAccountLabel: "tok", verifiedExternalAccountId: null },
    ],
    publicationTargets: [target()],
    fulfillmentNodes: [
      { id: 7, code: "MAIN", name: "Main Warehouse", nodeType: "internal_warehouse", warehouseId: 1, warehouseCode: "MAIN", lifecycleStatus: "active" },
      { id: 8, code: "CA3PL", name: "Canada 3PL", nodeType: "third_party_logistics", warehouseId: 2, warehouseCode: "CA", lifecycleStatus: "active" },
    ],
    policyHeads: [],
    policySubjects: [],
    sourceBindingHeads: [],
    variantMappingHeads: [],
    legacyMappingCandidates: [],
    runtimeAuthority: "canonical",
    runtimeAuthorityRevision: "9",
    providerWriteEnabled: false,
    ...overrides,
  };
}

export function previewRow(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    productVariantId: 101,
    sku: "CARD-P5",
    unitsPerVariant: 5,
    canonicalAtpUnits: "100",
    sharedUnits: "80",
    afterHoldbackUnits: "75",
    cappedUnits: "60",
    publishedUnits: "60",
    sourceWarehouseBreakdown: [
      { warehouseId: 1, canonicalAtpUnits: "60" },
      { warehouseId: 2, canonicalAtpUnits: "40" },
    ],
    policy: {
      allocationSemantics: "exposure",
      eligible: true,
      shareBps: 8_000,
      holdbackSellableUnits: "5",
      maxPublishSellableUnits: "60",
      minPublishSellableUnits: "0",
      sources: {
        allocationSemantics: "channel:3",
        eligible: "channel:3",
        shareBps: "channel:3:variant:101",
        holdbackSellableUnits: "channel:3:product:10",
        maxPublishSellableUnits: "channel:3:variant:101",
        minPublishSellableUnits: "channel:3",
      },
    },
    mapping: null,
    ...overrides,
  };
}
