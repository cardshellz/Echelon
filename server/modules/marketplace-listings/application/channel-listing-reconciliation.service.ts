import { z } from "zod";
import { shouldRepairInternalOnlyChannelStock } from "../domain/listing-member-lifecycle";

const sourceSchema = z.object({
  listingId: z.number().int().positive().safe(),
  productVariantId: z.number().int().positive().safe().nullable(),
  sku: z.string().min(1).max(255).refine(value => value.trim().length > 0),
  productActive: z.boolean().nullable(),
  variantActive: z.boolean().nullable(),
  productStatus: z.string().nullable(),
  salesEligibility: z.string().nullable(),
}).strict();
const observationSchema = z.object({
  inventoryItemExists: z.boolean(),
  hasActiveOffer: z.boolean(),
  availableQuantity: z.number().int().nonnegative().safe().nullable(),
}).strict().superRefine((observation,context) => {
  if (!observation.inventoryItemExists && observation.hasActiveOffer) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "A missing inventory item cannot confirm an active offer." });
  }
});

/** Provider adapters supply observations and effects; the shared owner decides
 * whether the saved listing needs a status change or an explicit stock repair. */
export class ChannelListingReconciliationService {
  constructor(private readonly ports: {
    observe(sku: string): Promise<unknown>;
    markDeleted(listingId: number): Promise<void>;
    markEnded(listingId: number): Promise<void>;
    queueStockRepair(productVariantId: number): Promise<void>;
  }) {}

  async reconcile(raw: z.input<typeof sourceSchema>) {
    const source = sourceSchema.parse(raw);
    const observation = observationSchema.parse(await this.ports.observe(source.sku));
    if (!observation.inventoryItemExists) {
      await this.ports.markDeleted(source.listingId);
      return { status: "deleted" as const, quantityDrift: false, availableQuantity: observation.availableQuantity };
    }
    if (!observation.hasActiveOffer) {
      await this.ports.markEnded(source.listingId);
      return { status: "ended" as const, quantityDrift: false, availableQuantity: observation.availableQuantity };
    }
    const repair = source.productVariantId !== null && shouldRepairInternalOnlyChannelStock({
      productActive: source.productActive,variantActive: source.variantActive,productStatus: source.productStatus,
      salesEligibility: source.salesEligibility,availableQuantity: observation.availableQuantity,
    });
    if (repair) await this.ports.queueStockRepair(source.productVariantId!);
    return { status: "active" as const, quantityDrift: repair, availableQuantity: observation.availableQuantity };
  }
}
