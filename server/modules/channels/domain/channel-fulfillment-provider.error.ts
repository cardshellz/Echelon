/** Safe, structured failures at the channel-owned fulfillment boundary. */
export class ChannelFulfillmentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly failureClass: "permanent" | "transient" = "permanent",
  ) {
    super(message);
    this.name = "ChannelFulfillmentProviderError";
  }
}
