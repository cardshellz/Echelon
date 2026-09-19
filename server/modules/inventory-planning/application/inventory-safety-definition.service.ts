import { z } from "zod";
import { applySafetyDefinitionSchema, safetyDefinitionSelectionSchema, type SafetyDefinitionSelection,
  type SafetyDefinitionReview, type ApplySafetyDefinition, type SafetyDefinitionReceipt, type SafetyDefinitionProgress,
} from "@shared/types/inventory-safety-definition";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export interface SafetyDefinitionStore {
  review(selection: SafetyDefinitionSelection): Promise<SafetyDefinitionReview>;
  apply(command: ApplySafetyDefinition, actor: string, requestHash: string, now: Date): Promise<SafetyDefinitionReceipt>;
  progress(scopeKey: string): Promise<SafetyDefinitionProgress | null>;
}
export class SafetyDefinitionService {
  constructor(private readonly store: SafetyDefinitionStore, private readonly clock = { now: () => new Date() }) {}
  review(input: unknown) { return this.store.review(safetyDefinitionSelectionSchema.parse(input)); }
  apply(input: unknown, actor: unknown) {
    const command = applySafetyDefinitionSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    return this.store.apply(command, authenticatedActor, inventoryCutoverEvidenceHash({ command, actor: authenticatedActor }), this.clock.now());
  }
  progress(scopeKey: unknown) { return this.store.progress(safetyDefinitionSelectionSchema.shape.scopeKey.parse(scopeKey)); }
}
