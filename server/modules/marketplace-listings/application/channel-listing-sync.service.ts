import {
  channelListingSyncCommandSchema, decideChannelListingSync,
  type ChannelListingSyncCommand, type ChannelListingSyncState,
  type ChannelListingSyncBlocker,
} from "../domain/channel-listing-sync";

export interface ChannelListingSyncAdapter<Receipt> {
  /** Exact command receipts, including refusals, precede today's catalog state. */
  receipt(command: ChannelListingSyncCommand): Promise<Receipt | null>;
  state(command: ChannelListingSyncCommand): Promise<ChannelListingSyncState>;
  admit(command: ChannelListingSyncCommand, operation: "create_or_adopt" | "update"): Promise<Receipt>;
  block(command: ChannelListingSyncCommand, blocker: ChannelListingSyncBlocker): Promise<Receipt>;
}

/** Sole create/update decision for manual, bulk and inclusion requests. Adapters
 * translate evidence and hand off to durable execution; this owner never
 * calculates stock or treats an unavailable read as an absent listing. */
export class ChannelListingSyncService<Receipt> {
  constructor(private readonly adapter: ChannelListingSyncAdapter<Receipt>) {}
  async request(input: ChannelListingSyncCommand): Promise<Receipt> {
    const command = channelListingSyncCommandSchema.parse(input);
    const prior = await this.adapter.receipt(command);
    if (prior !== null) return prior;
    const decision = decideChannelListingSync(await this.adapter.state(command));
    return "blocker" in decision
      ? this.adapter.block(command, decision.blocker)
      : this.adapter.admit(command, decision.operation);
  }
}
