import { z } from "zod";

const positiveId = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const remoteId = z.string().trim().regex(/^[1-9][0-9]*$/).max(30);
const CENTS_PER_UNIT = BigInt(100);
// Shopify's product model supports at most 2,048 variants per product.
export const SHOPIFY_PRODUCT_VARIANT_LIMIT = 2048;

export const shopifyProductConnectionRequestSchema = z.object({
  channelId: positiveId,
  currency: z.string().regex(/^[A-Z]{3}$/),
  mode: z.enum(["create", "link"]),
  targetProductRef: z.string().trim().max(500).optional(),
  prices: z.array(z.object({
    variantId: positiveId.nullable(),
    priceCents: cents,
    compareAtPriceCents: cents.nullable().optional(),
  }).strict()).max(SHOPIFY_PRODUCT_VARIANT_LIMIT).default([]),
  bindings: z.array(z.object({
    variantId: positiveId,
    remoteVariantId: remoteId,
  }).strict()).max(SHOPIFY_PRODUCT_VARIANT_LIMIT).default([]),
  publicationId: remoteId.nullable().default(null),
  productOnlyRequiresShipping: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.mode === "link" && !value.targetProductRef) {
    context.addIssue({ code: "custom", path: ["targetProductRef"], message: "Enter the Shopify product URL or ID." });
  }
  if (value.mode === "link" && (value.prices.length > 0 || value.publicationId !== null)) {
    context.addIssue({ code: "custom", message: "Linking an existing product cannot change its prices or publication." });
  }
  if (value.mode === "create" && (value.targetProductRef || value.bindings.length > 0)) {
    context.addIssue({ code: "custom", message: "Creation cannot select an existing Shopify product or variant." });
  }
  for (const key of ["prices", "bindings"] as const) {
    const ids = value[key].map(row => row.variantId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: [key], message: "Each catalog variant must appear only once." });
    }
  }
});

export type ShopifyProductConnectionRequest = z.infer<typeof shopifyProductConnectionRequestSchema>;
export const shopifyProductConnectionExecuteSchema = z.object({
  request: shopifyProductConnectionRequestSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  commandKey: z.string().uuid(),
}).strict();
export type ShopifyProductConnectionExecute = z.infer<typeof shopifyProductConnectionExecuteSchema>;

export interface ShopifyConnectionVariant {
  id: number;
  sku: string | null;
  name: string;
  requiresShipping: boolean;
  trackInventory: boolean;
  priceCents: number | null;
  compareAtPriceCents: number | null;
}

export interface ShopifyConnectionContext {
  productId: number;
  productName: string;
  productSku: string | null;
  channels: Array<{ id: number; name: string; isDefault: boolean }>;
  channelId: number;
  shopDomain: string;
  currency: string;
  mappingStatus: string;
  mappedProductId: string | null;
  variants: ShopifyConnectionVariant[];
  productOnly: boolean;
  blockedReason: string | null;
  publications: Array<{ id: string; name: string }>;
  publicationIssue: string | null;
  matchingProducts: Array<{ id: string; title: string; status: string }>;
  lookupIssue: string | null;
  pendingCommand: ShopifyProductConnectionCommand | null;
}

export interface ShopifyConnectionPreview {
  previewHash: string;
  mode: "create" | "link";
  productId: number;
  productName: string;
  channelId: number;
  channelName: string;
  shopDomain: string;
  currency: string;
  ready: boolean;
  issues: string[];
  targetProductId: string | null;
  targetTitle: string;
  variants: Array<{
    variantId: number | null;
    sku: string | null;
    name: string;
    remoteVariantId: string | null;
    priceCents: number | null;
  }>;
  remoteVariants: Array<{ id: string; sku: string | null; title: string }>;
  publicationName: string | null;
  warnings: string[];
}

export interface ShopifyProductConnectionCommand {
  commandKey: string;
  productId: number;
  channelId: number;
  mode: "create" | "link";
  state: "pending" | "creating" | "configuring" | "mapping" | "publishing" | "complete" | "review" | "rejected";
  remoteProductId: string | null;
  request: ShopifyProductConnectionRequest;
  previewHash: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryable: boolean;
  completedAt: string | null;
}

// Shared response validation also strips internal repository fields at the HTTP
// boundary. Saved commands never expose leases, credentials or source snapshots.
export const shopifyProductConnectionCommandSchema = z.object({
  commandKey: z.string().uuid(), productId: positiveId, channelId: positiveId,
  mode: z.enum(["create", "link"]),
  state: z.enum(["pending", "creating", "configuring", "mapping", "publishing", "complete", "review", "rejected"]),
  remoteProductId: remoteId.nullable(), request: shopifyProductConnectionRequestSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/), lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(), retryable: z.boolean(), completedAt: z.string().datetime().nullable(),
});
export const shopifyProductConnectionContextSchema = z.object({
  productId: positiveId, productName: z.string(), productSku: z.string().nullable(),
  channels: z.array(z.object({ id: positiveId, name: z.string(), isDefault: z.boolean() })),
  channelId: positiveId, shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  currency: z.string().regex(/^[A-Z]{3}$/), mappingStatus: z.string(), mappedProductId: remoteId.nullable(),
  variants: z.array(z.object({ id: positiveId, sku: z.string().nullable(), name: z.string(),
    requiresShipping: z.boolean(), trackInventory: z.boolean(), priceCents: cents.nullable(), compareAtPriceCents: cents.nullable() })),
  productOnly: z.boolean(), blockedReason: z.string().nullable(),
  publications: z.array(z.object({ id: remoteId, name: z.string() })), publicationIssue: z.string().nullable(),
  matchingProducts: z.array(z.object({ id: remoteId, title: z.string(), status: z.string() })), lookupIssue: z.string().nullable(),
  pendingCommand: shopifyProductConnectionCommandSchema.nullable(),
});
export const shopifyProductConnectionPreviewSchema = z.object({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(["create", "link"]),
  productId: positiveId, productName: z.string(), channelId: positiveId, channelName: z.string(),
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/), currency: z.string().regex(/^[A-Z]{3}$/),
  ready: z.boolean(), issues: z.array(z.string()), targetProductId: remoteId.nullable(), targetTitle: z.string(),
  variants: z.array(z.object({ variantId: positiveId.nullable(), sku: z.string().nullable(), name: z.string(),
    remoteVariantId: remoteId.nullable(), priceCents: cents.nullable() })),
  remoteVariants: z.array(z.object({ id: remoteId, sku: z.string().nullable(), title: z.string() })),
  publicationName: z.string().nullable(), warnings: z.array(z.string()),
});
export const shopifyProductConnectionResultSchema = z.object({ command: shopifyProductConnectionCommandSchema, replayed: z.boolean() });

export function parseShopifyConnectionMoney(value: string): number | null {
  if (value.length > 128) return null;
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * CENTS_PER_UNIT + BigInt(fraction.padEnd(2, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export function formatShopifyConnectionMoney(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("A price must be nonnegative safe integer cents.");
  const amount = BigInt(value);
  return `${amount / CENTS_PER_UNIT}.${String(amount % CENTS_PER_UNIT).padStart(2, "0")}`;
}
