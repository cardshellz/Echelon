import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  channelIntentAccountSchema, channelPreparedIntentInputSchema, channelPreparedIntentSchema,
  type ChannelIntentAccount, type ChannelPreparedIntent, type ChannelPreparedIntentInput,
  type ChannelPreparedMember,
} from "@shared/types/channel-prepared-intent";

export class ChannelPreparedIntentError extends Error {
  readonly code = "CHANNEL_PREPARED_INTENT_CHANGED";
  constructor() {
    super("The prepared listing account, source selection or content changed. Prepare the listing again before sending it.");
    this.name = "ChannelPreparedIntentError";
  }
}

/** The shared owner hashes resolved input; it never selects prices, pictures,
 * policies, stock, or provider effects on behalf of their existing owners. */
export function preparedChannelIntentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function prepareChannelIntent(input: ChannelPreparedIntentInput): ChannelPreparedIntent {
  const parsed = channelPreparedIntentInputSchema.parse(input);
  parsed.members.sort((a, b) => a.variantId - b.variantId);
  parsed.prices.sort((a, b) => a.variantId - b.variantId);
  return { input: parsed, intentHash: preparedChannelIntentHash(parsed) };
}

export function assertPreparedChannelIntent(value: unknown, expected: {
  account: ChannelIntentAccount;
  capabilityRevision: string;
  contentHash: string;
  members: readonly ChannelPreparedMember[];
}): ChannelPreparedIntent {
  const parsed = channelPreparedIntentSchema.safeParse(value);
  const account = channelIntentAccountSchema.safeParse(expected.account);
  if (!parsed.success || !account.success) throw new ChannelPreparedIntentError();
  const intent = parsed.data;
  const members = [...expected.members].sort((a, b) => a.variantId - b.variantId);
  if (intent.intentHash !== preparedChannelIntentHash(intent.input)
    || preparedChannelIntentHash(intent.input.account) !== preparedChannelIntentHash(account.data)
    || intent.input.capability.revision !== expected.capabilityRevision
    || intent.input.contentHash !== expected.contentHash
    || preparedChannelIntentHash(intent.input.members) !== preparedChannelIntentHash(members))
    throw new ChannelPreparedIntentError();
  return intent;
}
