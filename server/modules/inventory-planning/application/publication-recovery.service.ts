import { z } from "zod";
import { publicationRecoveryConfirmationSchema, publicationRecoveryPreviewSchema, publicationRecoveryResultSchema,
  type PublicationRecoveryPreview, type PublicationRecoveryResult } from "@shared/types/publication-recovery";
import { quantityPublicationScopeSchema, QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../domain/quantity-publication-admission";

export interface PublicationRecoveryCommand extends z.infer<typeof publicationRecoveryConfirmationSchema> {
  scopes: QuantityPublicationScope[];
  actor: string;
  now: Date;
}
export interface PublicationRecoveryStore {
  preview(scopes: readonly QuantityPublicationScope[]): Promise<PublicationRecoveryPreview>;
  resume(command: PublicationRecoveryCommand): Promise<PublicationRecoveryResult>;
}

/** Explicitly accepts unknown historical effects. It never invents termination,
 * acknowledgement, or quantities; the canonical publisher must read/replan next. */
export class PublicationRecoveryService {
  constructor(private readonly store: PublicationRecoveryStore, private readonly now: () => Date = () => new Date()) {}
  async preview(input: readonly QuantityPublicationScope[]): Promise<PublicationRecoveryPreview> {
    return publicationRecoveryPreviewSchema.parse(await this.store.preview(this.scopes(input)));
  }
  async resume(input: z.infer<typeof publicationRecoveryConfirmationSchema> & {
    scopes: readonly QuantityPublicationScope[]; actor: string;
  }): Promise<PublicationRecoveryResult> {
    const { scopes, actor, ...raw } = input;
    const command = publicationRecoveryConfirmationSchema.parse(raw);
    if (!scopes.some(scope => scope.productVariantId !== null)) throw new QuantityPublicationAdmissionError(
      "EBAY_RECOVERY_CATALOG_MAPPING_REQUIRED", "Review the listing's catalog variant mapping before resuming current inventory.");
    const at = z.date().parse(this.now());
    return publicationRecoveryResultSchema.parse(await this.store.resume({ ...command,
      scopes: this.scopes(scopes), actor: z.string().trim().min(1).max(100).parse(actor), now: new Date(at) }));
  }
  private scopes(input: readonly QuantityPublicationScope[]): QuantityPublicationScope[] {
    const scopes = z.array(quantityPublicationScopeSchema).min(1).max(251).parse(input);
    const first = scopes[0]!;
    if (new Set(scopes.map(scope => scope.externalInventoryItemId)).size !== scopes.length || scopes.some(scope =>
      scope.providerKey !== first.providerKey || scope.providerScopeType !== first.providerScopeType
      || scope.destinationKind !== first.destinationKind || scope.connectionId !== first.connectionId
      || scope.externalScopeId !== first.externalScopeId || scope.productId !== first.productId)) {
      throw new QuantityPublicationAdmissionError("EBAY_RECOVERY_SCOPE_INVALID", "Recovery requires distinct exact listing identities from one product and one provider connection.");
    }
    return scopes;
  }
}
