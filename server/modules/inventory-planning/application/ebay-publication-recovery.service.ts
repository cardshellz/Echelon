import { z } from "zod";
import { ebayPublicationRecoveryConfirmationSchema, ebayPublicationRecoveryPreviewSchema, ebayPublicationRecoveryResultSchema,
  type EbayPublicationRecoveryPreview, type EbayPublicationRecoveryResult } from "@shared/types/ebay-publication-recovery";
import { quantityPublicationScopeSchema, QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../domain/quantity-publication-admission";

export interface EbayPublicationRecoveryCommand extends z.infer<typeof ebayPublicationRecoveryConfirmationSchema> {
  scopes: QuantityPublicationScope[];
  actor: string;
  now: Date;
}
export interface EbayPublicationRecoveryStore {
  preview(scopes: readonly QuantityPublicationScope[]): Promise<EbayPublicationRecoveryPreview>;
  resume(command: EbayPublicationRecoveryCommand): Promise<EbayPublicationRecoveryResult>;
}

/** Explicitly accepts unknown historical effects. It never invents termination,
 * acknowledgement, or quantities; the canonical publisher must read/replan next. */
export class EbayPublicationRecoveryService {
  constructor(private readonly store: EbayPublicationRecoveryStore, private readonly now: () => Date = () => new Date()) {}
  async preview(input: readonly QuantityPublicationScope[]): Promise<EbayPublicationRecoveryPreview> {
    return ebayPublicationRecoveryPreviewSchema.parse(await this.store.preview(this.scopes(input)));
  }
  async resume(input: z.infer<typeof ebayPublicationRecoveryConfirmationSchema> & {
    scopes: readonly QuantityPublicationScope[]; actor: string;
  }): Promise<EbayPublicationRecoveryResult> {
    const { scopes, actor, ...raw } = input;
    const command = ebayPublicationRecoveryConfirmationSchema.parse(raw);
    if (!scopes.some(scope => scope.productVariantId !== null)) throw new QuantityPublicationAdmissionError(
      "EBAY_RECOVERY_CATALOG_MAPPING_REQUIRED", "Review the listing's catalog variant mapping before resuming current inventory.");
    const at = z.date().parse(this.now());
    return ebayPublicationRecoveryResultSchema.parse(await this.store.resume({ ...command,
      scopes: this.scopes(scopes), actor: z.string().trim().min(1).max(100).parse(actor), now: new Date(at) }));
  }
  private scopes(input: readonly QuantityPublicationScope[]): QuantityPublicationScope[] {
    const scopes = z.array(quantityPublicationScopeSchema).min(1).max(251).parse(input);
    if (scopes.some(scope => scope.providerKey !== "ebay" || scope.providerScopeType !== "account"
      || scope.externalScopeId !== scopes[0]!.externalScopeId)) {
      throw new QuantityPublicationAdmissionError("EBAY_RECOVERY_SCOPE_INVALID", "Recovery requires exact listing identities from one eBay account.");
    }
    return scopes;
  }
}
