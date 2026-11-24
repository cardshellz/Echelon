import { z } from "zod";

export class ChannelIdentityError extends Error {
  readonly status = 409;
  constructor(
    readonly code: string,
    message: string,
    readonly failureClass: "permanent" | "transient" = "permanent",
  ) {
    super(message);
    this.name = "ChannelIdentityError";
  }
}

export const internalIdentitySchema = z.number().int().positive().safe();
export const externalIdentitySchema = z.string().regex(/^[1-9]\d*$/);
export const providerRestIdentitySchema = z.union([
  z.number().int().positive().safe().transform(String), externalIdentitySchema,
]);

export interface ChannelItemIdentity {
  productVariantId: number;
  externalVariantId: string;
  externalProductId: string | null;
  externalInventoryItemId: string | null;
  externalSku: string | null;
}

/** Reverse matching never uses SKU text and never picks the first duplicate. */
export function indexInventoryIdentities(identities: readonly ChannelItemIdentity[]): Map<string, number> {
  const byExternalId = new Map<string, number>();
  const byVariantId = new Map<number, string>();
  for (const identity of identities) {
    internalIdentitySchema.parse(identity.productVariantId);
    if (!identity.externalInventoryItemId) continue;
    const previousVariant = byExternalId.get(identity.externalInventoryItemId);
    const previousExternal = byVariantId.get(identity.productVariantId);
    if ((previousVariant !== undefined && previousVariant !== identity.productVariantId)
      || (previousExternal !== undefined && previousExternal !== identity.externalInventoryItemId)) {
      throw new ChannelIdentityError("CHANNEL_INVENTORY_IDENTITY_AMBIGUOUS", "Inventory mappings are not one-to-one within this channel");
    }
    byExternalId.set(identity.externalInventoryItemId, identity.productVariantId);
    byVariantId.set(identity.productVariantId, identity.externalInventoryItemId);
  }
  return byExternalId;
}
