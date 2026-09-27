import { z } from "zod";
import { historyReviewSchema, retireHistoryRequestSchema, historyRetirementResultSchema,
  type HistoryReview, type RetireHistoryRequest, type HistoryRetirementResult } from "@shared/types/inventory-cutover-history";
import { CutoverHistoryError } from "../domain/inventory-cutover-history-retirement";
import { reconstructionHash } from "../domain/inventory-cutover-reconstruction";

export interface RetireHistoryCommand extends RetireHistoryRequest { actor: string; requestHash: string }
export interface CutoverHistoryStore {
  review(): Promise<HistoryReview>;
  retire(command: RetireHistoryCommand): Promise<HistoryRetirementResult>;
}

/** Actor comes from the authenticated caller, never the request body. Transaction
 * timestamps and admission belong to the store; no provider is involved. */
export class InventoryCutoverHistoryService {
  constructor(private readonly store: CutoverHistoryStore) {}

  async review(actorInput: unknown): Promise<HistoryReview> {
    this.actor(actorInput);
    return historyReviewSchema.parse(await this.store.review());
  }

  async retire(raw: unknown, actorInput: unknown): Promise<HistoryRetirementResult> {
    const actor = this.actor(actorInput);
    const parsed = retireHistoryRequestSchema.safeParse(raw);
    if (!parsed.success) throw new CutoverHistoryError("HISTORY_REQUEST_INVALID", "A complete reviewed retirement command is required.", 400);
    const requestHash = reconstructionHash({ contractVersion: "inventory_cutover_history_retire_v1", actor, ...parsed.data });
    return historyRetirementResultSchema.parse(await this.store.retire({ ...parsed.data, actor, requestHash }));
  }

  private actor(input: unknown): string {
    const actor = z.string().trim().min(1).max(100).safeParse(input);
    if (!actor.success) throw new CutoverHistoryError("HISTORY_ACTOR_REQUIRED", "An authenticated activation operator is required.", 401);
    return actor.data;
  }
}
