import { z } from "zod";
import { channelCatalogItemSchema, channelCatalogLinkSchema, channelCatalogQuerySchema, channelCatalogPageSchema,
  type ChannelCatalogItem, type ChannelCatalogMapping, type ChannelCatalogPage, type ChannelCatalogQuery,
  type ChannelCatalogRow, type ChannelCatalogVariant, type ChannelCatalogView } from "@shared/types/channel-catalog";
import { ChannelIdentityError } from "./channel-identity.domain";

export interface ChannelCatalogAccount {
  channelId: number;
  connectionId: number;
  provider: string;
}
/** Provider adapters only resolve an authenticated account and translate reads. */
export interface ChannelCatalogProvider {
  account(channelId: number): Promise<ChannelCatalogAccount>;
  list(account: ChannelCatalogAccount, query: ChannelCatalogQuery): Promise<ChannelCatalogPage>;
  item(account: ChannelCatalogAccount, sku: string): Promise<ChannelCatalogItem>;
}
export interface ChannelCatalogMappingRecord {
  productVariantId: number; sku: string; externalVariantId: string | null;
  externalInventoryItemId: string | null; active: boolean;
}
export interface VerifiedChannelCatalogMapping {
  item: ChannelCatalogItem;
  productVariantId: number;
  expectedLocalSku: string | null;
}
export interface ChannelCatalogRepository {
  candidates(channelId: number, skus: readonly string[]): Promise<{
    variants: ChannelCatalogVariant[]; mappings: ChannelCatalogMappingRecord[];
  }>;
  searchVariants(query: string): Promise<ChannelCatalogVariant[]>;
  saveMappings(account: ChannelCatalogAccount, items: readonly VerifiedChannelCatalogMapping[],
    actor: string, now: Date): Promise<void>;
}

export function matchChannelCatalog(items: readonly ChannelCatalogItem[], variants: readonly ChannelCatalogVariant[],
  mappings: readonly ChannelCatalogMappingRecord[]): ChannelCatalogRow[] {
  return items.map(item => {
    const existing = mappings.filter(mapping => mapping.sku === item.sku);
    const candidates = variants.filter(variant => variant.sku === item.sku);
    if (existing.length === 1) {
      const mapping = existing[0];
      const variant = variants.find(candidate => candidate.id === mapping.productVariantId) ?? null;
      const valid = variant?.eligible && mapping.active && mapping.externalVariantId === item.externalVariantId
        && mapping.externalInventoryItemId === item.externalInventoryItemId;
      return { ...item, variant, mappingStatus: valid ? "linked" : "conflict",
        message: valid ? null : "The existing mapping needs review; it cannot be replaced automatically." };
    }
    if (existing.length > 1 || candidates.length > 1) {
      return { ...item, variant: null, mappingStatus: "conflict", message: "Multiple identities match this SKU." };
    }
    const variant = candidates[0] ?? null;
    if (variant && mappings.some(mapping => mapping.productVariantId === variant.id && mapping.sku !== item.sku)) {
      return { ...item, variant, mappingStatus: "conflict", message: "This Echelon variant is already linked to another SKU." };
    }
    if (variant && !variant.eligible) {
      return { ...item, variant, mappingStatus: "unavailable", message: "This Echelon variant is not available for fulfillment." };
    }
    return { ...item, variant, mappingStatus: variant ? "matched" : "unmatched", message: null };
  });
}

export class ChannelCatalogService {
  constructor(private readonly repository: ChannelCatalogRepository, private readonly provider: ChannelCatalogProvider,
    private readonly now: () => Date = () => new Date()) {}

  async list(channelId: number, input: unknown): Promise<ChannelCatalogView> {
    const query = channelCatalogQuerySchema.parse(input);
    const account = await this.provider.account(channelId);
    const page = channelCatalogPageSchema.parse(await this.provider.list(account, query));
    const items = page.items;
    if (new Set(items.map(item => item.sku)).size !== items.length) {
      throw new ChannelIdentityError("CHANNEL_CATALOG_DUPLICATE_SKU", "The provider returned duplicate SKU identities");
    }
    const local = await this.repository.candidates(channelId, items.map(item => item.sku));
    return { ...page, items: matchChannelCatalog(items, local.variants, local.mappings) };
  }

  async link(channelId: number, input: unknown, actor: string): Promise<{ linked: number }> {
    const { mappings } = channelCatalogLinkSchema.parse(input);
    const account = await this.provider.account(channelId);
    return this.linkForAccount(account, mappings, actor);
  }

  /** Order intake may resolve only unique exact SKU matches, never fuzzy candidates. */
  async linkExactSkus(channelId: number, skus: readonly string[], actor: string): Promise<void> {
    const unique = z.array(z.string().trim().min(1).max(100)).max(500).parse([...new Set(skus)]);
    if (unique.length === 0) return;
    const account = await this.provider.account(channelId);
    const local = await this.repository.candidates(channelId, unique);
    const mappings: ChannelCatalogMapping[] = [];
    for (const sku of unique) {
      if (local.mappings.some(mapping => mapping.sku === sku)) continue;
      const candidates = local.variants.filter(variant => variant.sku === sku);
      if (candidates.length === 1 && candidates[0].eligible
        && !local.mappings.some(mapping => mapping.productVariantId === candidates[0].id)) {
        mappings.push({ sku, productVariantId: candidates[0].id });
      }
    }
    // Bound provider reads and transaction size for large orders.
    for (let offset = 0; offset < mappings.length; offset += 100) {
      await this.linkForAccount(account, mappings.slice(offset, offset + 100), actor, true);
    }
  }

  async searchVariants(query: unknown): Promise<ChannelCatalogVariant[]> {
    return this.repository.searchVariants(z.string().trim().min(2).max(100).parse(query));
  }

  private async linkForAccount(account: ChannelCatalogAccount, mappings: readonly ChannelCatalogMapping[], actor: string, requireExactSku = false) {
    z.string().trim().min(1).max(200).parse(actor);
    const verified: VerifiedChannelCatalogMapping[] = [];
    // Limit concurrent provider reads while keeping a full page below HTTP timeouts.
    // All identities must be verified before the single atomic persistence call.
    const verificationConcurrency = 5;
    for (let offset = 0; offset < mappings.length; offset += verificationConcurrency) {
      verified.push(...await Promise.all(mappings.slice(offset, offset + verificationConcurrency).map(async mapping => {
        const item = channelCatalogItemSchema.parse(await this.provider.item(account, mapping.sku));
        if (item.sku !== mapping.sku) throw new ChannelIdentityError("CHANNEL_CATALOG_IDENTITY_CHANGED", "The provider returned a different SKU; refresh the listing feed");
        return { item, productVariantId: mapping.productVariantId, expectedLocalSku: requireExactSku ? mapping.sku : null };
      })));
    }
    await this.repository.saveMappings(account, verified, actor, this.now());
    return { linked: verified.length };
  }
}
