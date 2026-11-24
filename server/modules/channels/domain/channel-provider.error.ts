/** Safe application errors from provider adapters; never carry raw payloads or secrets. */
export class ChannelProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status: number | null = null) {
    super(message);
    this.name = "ChannelProviderError";
  }
}
