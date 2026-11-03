/**
 * A recurring recovery must keep observing the provider: a previously unknown
 * request can arrive after an earlier successful check. Only a fresh, complete
 * comparison can avoid another durable Sync command.
 */
export class ChannelRecoverySyncService<Receipt, Evidence> {
  constructor(private readonly adapter: {
    receipt(): Promise<Receipt | null>;
    inspect(): Promise<Evidence | null>;
    enqueue(): Promise<Receipt>;
    inspectionFailed?(error: unknown): void;
  }) {}

  async check(forceSync: boolean): Promise<{ receipt: Receipt } | { verified: Evidence }> {
    // Replay wins even when the provider now matches. The earlier command may
    // have committed before its caller lost the acknowledgement.
    const prior = await this.adapter.receipt();
    if (prior !== null) return { receipt: prior };
    if (!forceSync) {
      try {
        const evidence = await this.adapter.inspect();
        if (evidence !== null) return { verified: evidence };
      } catch (error) {
        // A failed read is not a match. The normal Sync owner classifies and
        // records the failure, including its provider diagnostic.
        this.adapter.inspectionFailed?.(error);
      }
    }
    return { receipt: await this.adapter.enqueue() };
  }
}
