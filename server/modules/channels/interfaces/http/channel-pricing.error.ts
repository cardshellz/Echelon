import type { Response } from "express";
import { ZodError } from "zod";
import { ChannelPricingError } from "../../channel-pricing.domain";

function postgresSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const details = error as { code?: unknown; cause?: unknown };
  if (typeof details.code === "string" && /^[A-Z0-9]{5}$/.test(details.code)) {
    return details.code;
  }
  if (details.cause !== null && typeof details.cause === "object") {
    const code = (details.cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** Share safe HTTP errors without exposing database messages or submitted values. */
export function sendChannelPricingError(
  response: Response,
  error: unknown,
  operation = "channel_pricing_http",
): void {
  const known = error instanceof ChannelPricingError;
  const invalid = error instanceof ZodError;
  const code = known
    ? error.code
    : invalid
      ? "CHANNEL_PRICING_INPUT_INVALID"
      : "CHANNEL_PRICING_UNAVAILABLE";
  const message = known
    ? error.message
    : invalid
      ? "Check the pricing scope and enter valid amounts."
      : "Pricing could not be saved or loaded. Please try again.";
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)
    ? error.name
    : "UnknownError";

  // Only exception type and SQLSTATE are diagnostic data; messages may contain SQL or values.
  console.error(JSON.stringify({ operation, code, errorName, sqlState: postgresSqlState(error) }));
  response.status(known ? error.status : invalid ? 400 : 500).json({
    code,
    error: message,
  });
}
