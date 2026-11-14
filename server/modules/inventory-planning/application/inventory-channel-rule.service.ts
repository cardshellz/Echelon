import { z } from "zod";
import {
  applyChannelRuleSchema, channelRuleCopyResultSchema, channelRuleProgressSchema, channelRuleReceiptSchema, channelRuleReviewSchema,
  channelRuleScopeKeySchema, channelRuleSelectionSchema, channelRuleSetResultSchema, copyChannelRulesSchema, setChannelRuleSchema,
  type ApplyChannelRule, type ChannelRuleCopyResult, type ChannelRuleProgress, type ChannelRuleReceipt, type ChannelRuleReview,
  type ChannelRuleSelection, type ChannelRuleSetResult, type CopyChannelRules, type SetChannelRule,
} from "@shared/types/inventory-channel-rule";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { ChannelDefinitionError } from "./inventory-channel-definition.service";

/** Applies one saved product or SKU rule (shared/types/inventory-channel-rule.ts). */
export interface ChannelRuleStore {
  review(selection: ChannelRuleSelection): Promise<ChannelRuleReview>;
  apply(command: ApplyChannelRule, actor: string, requestHash: string, now: Date): Promise<ChannelRuleReceipt>;
  /** Saves, reviews and applies one rule in a single transaction; a refusal leaves no rows. */
  set(command: SetChannelRule, actor: string, requestHash: string, now: Date): Promise<ChannelRuleSetResult>;
  /** Copies a channel's rules to a channel that has none and applies them in a single transaction. */
  copy(command: CopyChannelRules, actor: string, requestHash: string, now: Date): Promise<ChannelRuleCopyResult>;
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

  async set(input: unknown, actor: unknown): Promise<ChannelRuleSetResult> {
    const command = setChannelRuleSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    const now = z.date().parse(this.clock.now());
    // Shares the receipt table and retry-key space with both applies; the kind
    // keeps a reused key from ever matching another command's hash.
    const requestHash = inventoryCutoverEvidenceHash({ kind: "channel_rule_set", command, actor: authenticatedActor });
    return validatedResponse(channelRuleSetResultSchema, await this.store.set(command, authenticatedActor, requestHash, now));
  }

  async copy(input: unknown, actor: unknown): Promise<ChannelRuleCopyResult> {
    const command = copyChannelRulesSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    const now = z.date().parse(this.clock.now());
    // Same receipt table and retry-key space as the applies and the set; the kind keeps the hashes apart.
    const requestHash = inventoryCutoverEvidenceHash({ kind: "channel_rule_copy", command, actor: authenticatedActor });
    return validatedResponse(channelRuleCopyResultSchema, await this.store.copy(command, authenticatedActor, requestHash, now));
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
