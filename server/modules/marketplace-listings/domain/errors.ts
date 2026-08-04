export type MarketplaceListingReplacementErrorContext = Readonly<
  Record<string, unknown>
>;

export class MarketplaceListingReplacementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: MarketplaceListingReplacementErrorContext = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketplaceListingReplacementError";
  }

  toJSON(): {
    code: string;
    message: string;
    context: MarketplaceListingReplacementErrorContext;
  } {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}
