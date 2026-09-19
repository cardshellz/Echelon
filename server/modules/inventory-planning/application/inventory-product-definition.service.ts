import { z } from "zod";
import {
  applyProductDefinitionSchema, productDefinitionSelectionSchema,
  type ApplyProductDefinition, type ProductDefinitionSelection, type ProductDefinitionReview,
  type ProductDefinitionReceipt, type ProductDefinitionProgress,
} from "@shared/types/inventory-product-definition";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export class ProductDefinitionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export interface ProductDefinitionStore {
  review(selection: ProductDefinitionSelection): Promise<ProductDefinitionReview>;
  apply(command: ApplyProductDefinition, actor: string, requestHash: string, now: Date): Promise<ProductDefinitionReceipt>;
  progress(productId: number): Promise<ProductDefinitionProgress | null>;
}
export class ProductDefinitionService {
  constructor(private readonly store: ProductDefinitionStore, private readonly clock = { now: () => new Date() }) {}
  review(input: unknown) { return this.store.review(productDefinitionSelectionSchema.parse(input)); }
  apply(input: unknown, actor: unknown) {
    const command = applyProductDefinitionSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    return this.store.apply(command, authenticatedActor,
      inventoryCutoverEvidenceHash({ command, actor: authenticatedActor }), this.clock.now());
  }
  progress(productId: unknown) { return this.store.progress(z.number().int().positive().max(2_147_483_647).parse(productId)); }
}
