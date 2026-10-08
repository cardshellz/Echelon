import { z } from "zod";
import { publicationMembershipReceiptSchema } from "@shared/types/inventory-publication-membership";
import { InventoryPublicationMembershipError } from "./inventory-publication-membership.service";

const id = z.number().int().positive().max(2_147_483_647);
const identity = z.string().trim().min(1).max(100);
export const verifiedStockListingSchema = z.object({
  channelId: id,
  connectionId: id,
  accountId: identity,
  environment: z.enum(["production", "sandbox"]),
  externalScopeId: identity,
  productVariantId: id,
  sku: identity,
  externalProductId: identity,
  lifecycleStatus: z.literal("ACTIVE"),
  publishedStatus: z.literal("PUBLISHED"),
  observedAt: z.string().datetime(),
}).strict();
export type VerifiedStockListing = z.infer<typeof verifiedStockListingSchema>;
const stockConnectionResultSchema = z.object({
  state: z.enum(["connected", "already_connected", "excluded"]), dryRun: z.boolean(),
  receipt: publicationMembershipReceiptSchema.nullable(),
  quantities: z.array(z.object({ productVariantId: id, desiredQuantity: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict()),
}).strict();
export type VerifiedListingStockResult = z.infer<typeof stockConnectionResultSchema>;
export interface VerifiedListingStockStore {
  pending(channelId: number, connectionId: number, variantIds: number[]): Promise<number[]>;
  connect(input: VerifiedStockListing, now: Date, dryRun: boolean): Promise<VerifiedListingStockResult>;
}

const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
/** Internal inventory-owner entry point. The channel supplies a fresh provider
 * observation; stock quantities always come from the active ATP planner. */
export class VerifiedListingStockService {
  constructor(private readonly store: VerifiedListingStockStore, private readonly now: () => Date = () => new Date()) {}

  async pending(channelId: number, connectionId: number, variantIds: number[]): Promise<number[]> {
    const candidates = z.array(id).max(500).parse(variantIds);
    return z.array(id).refine(values => new Set(values).size === values.length && values.every(value => candidates.includes(value)))
      .parse(await this.store.pending(id.parse(channelId), id.parse(connectionId), candidates));
  }

  connect(raw: unknown, options: { dryRun?: boolean } = {}): Promise<VerifiedListingStockResult> {
    const input = verifiedStockListingSchema.parse(raw);
    const now = z.date().parse(this.now());
    const age = now.getTime() - Date.parse(input.observedAt);
    if (age < 0 || age > MAX_OBSERVATION_AGE_MS) {
      throw new InventoryPublicationMembershipError("STOCK_LISTING_OBSERVATION_EXPIRED", "Read the current Walmart listing before connecting stock.");
    }
    return this.store.connect(input, now, options.dryRun === true).then(result => stockConnectionResultSchema.parse(result));
  }
}
