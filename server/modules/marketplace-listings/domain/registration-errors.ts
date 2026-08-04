export type MarketplaceListingRegistrationErrorContext = Readonly<
  Record<string, unknown>
>;

export class MarketplaceListingRegistrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: MarketplaceListingRegistrationErrorContext = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MarketplaceListingRegistrationError";
  }

  toJSON(): {
    code: string;
    message: string;
    context: MarketplaceListingRegistrationErrorContext;
  } {
    return { code: this.code, message: this.message, context: this.context };
  }
}
