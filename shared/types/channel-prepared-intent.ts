import { z } from "zod";
import { catalogPublicationMediaPlanSchema } from "./catalog-publication-media";
import { channelPriceProvenanceSchema } from "./channel-listing-price";

const id = z.number().int().positive().max(2_147_483_647);
const identity = z.string().min(1).max(255).refine(value => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Routing identity is separate from remote account identity. Two business owners
 * must never acquire each other's commands simply because they share credentials. */
export const channelIntentAccountSchema = z.object({
  owner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("channel"), channelId: id }).strict(),
    z.object({ kind: z.literal("dropship"), vendorId: id, storeId: id }).strict(),
  ]),
  connectionId: id,
  provider: z.enum(["ebay", "walmart", "shopify"]),
  accountId: identity,
  environment: z.enum(["production", "sandbox"]),
  marketplaceId: identity,
  inventoryScope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("account") }).strict(),
    z.object({ kind: z.literal("location"), locationId: identity }).strict(),
  ]),
  // A numeric revision or deterministic digest supplied by the connection owner.
  configurationRevision: identity,
}).strict();
export type ChannelIntentAccount = z.infer<typeof channelIntentAccountSchema>;

export const channelPreparedMemberSchema = z.object({
  productId: id,
  variantId: id,
  sku: identity,
}).strict();
export type ChannelPreparedMember = z.infer<typeof channelPreparedMemberSchema>;

export const channelPreparedIntentInputSchema = z.object({
  schemaVersion: z.literal(1),
  account: channelIntentAccountSchema,
  operation: z.enum(["publication", "maintenance"]),
  capability: z.object({
    revision: identity,
    protocol: z.enum(["resource_steps", "feed"]),
    aggregate: z.enum(["item", "variation_group"]),
    quantityAdmission: z.literal("inventory_owner_required"),
    mediaVerification: z.enum(["resource_content", "unavailable"]),
  }).strict(),
  members: z.array(channelPreparedMemberSchema).min(1).max(500),
  // The adapter supplies its quantity-free projection. This does not authorize stock.
  contentHash: digest,
  mediaAction: z.enum(["replace", "preserve"]),
  mediaPlan: catalogPublicationMediaPlanSchema.nullable(),
  prices: z.array(z.object({
    variantId: id,
    cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    provenance: channelPriceProvenanceSchema.nullable(),
    resolutionRevision: digest,
  }).strict()).min(1).max(500),
  settings: z.object({ owner: identity, sourceRevision: digest }).strict(),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.members.map(member => member.variantId));
  if (ids.size !== value.members.length || new Set(value.members.map(member => member.sku)).size !== value.members.length)
    context.addIssue({ code: "custom", path: ["members"], message: "Prepared members must have unique local identities and provider SKUs." });
  if (value.prices.length !== ids.size || new Set(value.prices.map(price => price.variantId)).size !== ids.size
    || value.prices.some(price => !ids.has(price.variantId) || (price.provenance !== null && price.provenance.variantId !== price.variantId)))
    context.addIssue({ code: "custom", path: ["prices"], message: "Price provenance must identify exactly the prepared members." });
  if (value.mediaAction === "preserve" && value.mediaPlan !== null)
    context.addIssue({ code: "custom", path: ["mediaPlan"], message: "Preserved provider media cannot claim a replacement media plan." });
  if (value.mediaPlan && (value.mediaPlan.variants.length !== ids.size
    || new Set(value.mediaPlan.variants.map(member => member.variantId)).size !== ids.size
    || value.mediaPlan.variants.some(member => !ids.has(member.variantId))))
    context.addIssue({ code: "custom", path: ["mediaPlan"], message: "Media provenance must identify exactly the prepared members." });
});
export type ChannelPreparedIntentInput = z.infer<typeof channelPreparedIntentInputSchema>;
export const channelPreparedIntentSchema = z.object({
  input: channelPreparedIntentInputSchema,
  intentHash: digest,
}).strict();
export type ChannelPreparedIntent = z.infer<typeof channelPreparedIntentSchema>;
