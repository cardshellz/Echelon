import { z } from "zod";
import { applySafetyDefinitionSchema, promiseSafetyOverviewSchema, safetyDefinitionSelectionSchema, safetyDefinitionSetResultSchema,
  setSafetyDefinitionSchema, type SafetyDefinitionSelection,
  type SafetyDefinitionReview, type ApplySafetyDefinition, type SafetyDefinitionReceipt, type SafetyDefinitionProgress,
  type PromiseSafetyOverview, type SafetyDefinitionSetResult, type SetSafetyDefinition,
} from "@shared/types/inventory-safety-definition";
import { ProductDefinitionError } from "./inventory-product-definition.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export interface SafetyDefinitionStore {
  review(selection: SafetyDefinitionSelection): Promise<SafetyDefinitionReview>;
  apply(command: ApplySafetyDefinition, actor: string, requestHash: string, now: Date): Promise<SafetyDefinitionReceipt>;
  progress(scopeKey: string): Promise<SafetyDefinitionProgress | null>;
  /** Saves, reviews and applies one setting in a single transaction; a refusal leaves no rows. */
  set(command: SetSafetyDefinition, actor: string, requestHash: string, now: Date): Promise<SafetyDefinitionSetResult>;
  overview(): Promise<PromiseSafetyOverview>;
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
  async set(input: unknown, actor: unknown): Promise<SafetyDefinitionSetResult> {
    const command = setSafetyDefinitionSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    // Shares the receipt table and retry-key space with apply; the kind keeps a
    // reused key from ever matching the other command's hash.
    const requestHash = inventoryCutoverEvidenceHash({ kind: "safety_definition_set", command, actor: authenticatedActor });
    const result = safetyDefinitionSetResultSchema.safeParse(
      await this.store.set(command, authenticatedActor, requestHash, z.date().parse(this.clock.now())));
    // An invalid answer after a committed set is not a rejected request: keep the retry identity (5xx, never 4xx).
    if (!result.success) throw new ProductDefinitionError("DEFINITION_RESULT_INVALID", "The result could not be verified. Retry with the same command key.", 500);
    return result.data;
  }
  async overview(): Promise<PromiseSafetyOverview> { return promiseSafetyOverviewSchema.parse(await this.store.overview()); }
}
