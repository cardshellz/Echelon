import { z } from "zod";
import {
  applyChannelRuleSchema, channelRuleProgressSchema, channelRuleReceiptSchema, channelRuleReviewSchema,
  channelRuleScopeKeySchema, channelRuleSelectionSchema,
  type ApplyChannelRule, type ChannelRuleProgress, type ChannelRuleReceipt, type ChannelRuleReview, type ChannelRuleSelection,
} from "@shared/types/inventory-channel-rule";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { ChannelDefinitionError } from "./inventory-channel-definition.service";

/** Applies one saved product or SKU rule (shared/types/inventory-channel-rule.ts). */
export interface ChannelRuleStore {
  review(selection: ChannelRuleSelection): Promise<ChannelRuleReview>;
  apply(command: ApplyChannelRule, actor: string, requestHash: string, now: Date): Promise<ChannelRuleReceipt>;
  progress(scopeKey: string): Promise<ChannelRuleProgress | null>;
}

export class ChannelRuleService {
  constructor(private readonly store: ChannelRuleStore, private readonly clock = { now: () => new Date() }) {}

  async review(input: unknown): Promise<ChannelRuleReview> {
    const selection = channelRuleSelectionSchema.parse(input);
    return validatedResponse(channelRuleReviewSchema, await this.store.review(selection));
  }

  async apply(input: unknown, actor: unknown): Promise<ChannelRuleReceipt> {
    const command = applyChannelRuleSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    const now = z.date().parse(this.clock.now());
    // Rule and whole-channel applies share one receipt table and retry-key space.
    // The kind keeps a reused key from ever matching the other command's hash.
    const requestHash = inventoryCutoverEvidenceHash({ kind: "channel_rule", command, actor: authenticatedActor });
    return validatedResponse(channelRuleReceiptSchema, await this.store.apply(command, authenticatedActor, requestHash, now));
  }

  async progress(scopeKey: unknown): Promise<ChannelRuleProgress | null> {
    return validatedResponse(channelRuleProgressSchema.nullable(), await this.store.progress(channelRuleScopeKeySchema.parse(scopeKey)));
  }
}

function validatedResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // An invalid answer after a committed Apply is not a rejected request.
    // Keep the retry identity: a server error, never a 4xx.
    throw new ChannelDefinitionError("CHANNEL_RULE_RESULT_INVALID", "The result could not be verified. Retry with the same command key.", 500);
  }
  return result.data;
}
