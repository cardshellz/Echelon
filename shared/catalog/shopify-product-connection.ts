import { z } from "zod";

const positiveId = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const remoteId = z.string().trim().regex(/^[1-9][0-9]*$/).max(30);

export const shopifyProductConnectionRequestSchema = z.object({
  channelId: positiveId,
  mode: z.enum(["create", "link"]),
  targetProductRef: z.string().trim().max(500).optional(),
  prices: z.array(z.object({
    variantId: positiveId.nullable(),
    priceCents: cents,
    compareAtPriceCents: cents.nullable().optional(),
  }).strict()).max(2048).default([]),
  bindings: z.array(z.object({
    variantId: positiveId,
    remoteVariantId: remoteId,
  }).strict()).max(2048).default([]),
  publicationId: remoteId.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.mode === "link" && !value.targetProductRef) {
    context.addIssue({ code: "custom", path: ["targetProductRef"], message: "Enter the Shopify product URL or ID." });
  }
  if (value.mode === "link" && (value.prices.length > 0 || value.publicationId !== null)) {
    context.addIssue({ code: "custom", message: "Linking an existing product cannot change its prices or publication." });
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
  mappingStatus: string;
  mappedProductId: string | null;
  variants: ShopifyConnectionVariant[];
  productOnly: boolean;
  blockedReason: string | null;
  publications: Array<{ id: string; name: string }>;
  publicationIssue: string | null;
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
  state: "pending" | "creating" | "configuring" | "mapping" | "publishing" | "complete" | "review";
  remoteProductId: string | null;
  request: ShopifyProductConnectionRequest;
  previewHash: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryable: boolean;
  completedAt: string | null;
}

export function parseShopifyConnectionMoney(value: string): number | null {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export function formatShopifyConnectionMoney(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("A price must be nonnegative safe integer cents.");
  const amount = BigInt(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}
