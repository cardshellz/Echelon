import { z } from "zod";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import type { ListingMemberLifecycleAdapter } from "../../application/listing-member-lifecycle.port";
import { ListingMemberLifecycleError } from "../../domain/listing-member-lifecycle";

export interface ShopifyListingMemberClient { graphql(query: string, variables: Record<string, unknown>): Promise<unknown> }
function gid(kind: "Product" | "ProductVariant", value: string | null): string {
  if (value && new RegExp(`^(?:gid://shopify/${kind}/)?[1-9][0-9]*$`).test(value))
    return value.startsWith("gid:") ? value : `gid://shopify/${kind}/${value}`;
  throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_INCOMPLETE", "The saved Shopify product and variant IDs are required. Repair this archived variant's listing link.");
}
const observationSchema = z.object({ data: z.object({ productVariant: z.object({ id: z.string(), sku: z.string().nullable(),
  product: z.object({ id: z.string() }) }).nullable() }) });
const deletionSchema = z.object({ data: z.object({ productVariantsBulkDelete: z.object({ userErrors: z.array(z.object({ message: z.string() })) }) }) });

export class ShopifyListingMemberAdapter implements ListingMemberLifecycleAdapter {
  constructor(private readonly client: (identity: ListingMemberIdentity) => Promise<ShopifyListingMemberClient>) {}
  async observe(identity: ListingMemberIdentity) {
    const id = gid("ProductVariant", identity.externalVariantId);
    const result = observationSchema.parse(await (await this.client(identity)).graphql(
      "query ArchivedMember($id: ID!) { productVariant(id:$id) { id sku product { id } } }", { id }));
    const member = result.data.productVariant;
    if (member && (member.id !== id || member.product.id !== gid("Product", identity.externalProductId)
      || (identity.externalSku !== null && member.sku !== identity.externalSku)))
      throw new ListingMemberLifecycleError("LISTING_MEMBER_IDENTITY_CHANGED", "The Shopify variant does not match the retained product and SKU. Repair its link before removal.");
    return { identity, retired: member === null };
  }
  async retire(identity: ListingMemberIdentity): Promise<void> {
    if ((await this.observe(identity)).retired) return;
    const client = await this.client(identity);
    const variables = { productId: gid("Product", identity.externalProductId), variantsIds: [gid("ProductVariant", identity.externalVariantId)] };
    let result: z.infer<typeof deletionSchema>;
    try {
      result = deletionSchema.parse(await client.graphql(
        "mutation RetireMember($productId: ID!, $variantsIds: [ID!]!) { productVariantsBulkDelete(productId:$productId, variantsIds:$variantsIds) { userErrors { message } } }",
        variables));
    } catch (error) {
      if (error instanceof ListingMemberLifecycleError) throw error;
      throw new ListingMemberLifecycleError("LISTING_MEMBER_REMOVAL_UNCERTAIN",
        "The Shopify removal response was not confirmed. Echelon will check this exact variant.", "unknown");
    }
    if (result.data.productVariantsBulkDelete.userErrors.length)
      throw new ListingMemberLifecycleError("LISTING_MEMBER_REMOVAL_REJECTED", "Shopify rejected removal of this exact variant. Review its listing before retrying.");
  }
}
