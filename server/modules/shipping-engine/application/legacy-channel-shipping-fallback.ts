import type { LegacyChannelShippingFallback } from "../domain/channel-shipping-policy";
import {
  getShippingChannelProfile,
  type ShippingSalesChannel,
} from "../domain/shipping-channel";

/**
 * Translate the pre-policy channel profile into the canonical decision shape.
 * Callers must still resolve the canonical numeric channel ID independently.
 */
export function buildLegacyChannelShippingFallback(
  channel: ShippingSalesChannel,
): LegacyChannelShippingFallback {
  const profile = getShippingChannelProfile(channel);
  if (profile.quoteMode === "runtime_quote") {
    return {
      purpose: profile.ratePurpose,
      mode: "engine_quoted",
      eligibilityMode: "engine",
      rateContext: {
        pricingChannel: channel,
        purpose: profile.ratePurpose,
      },
    };
  }

  return {
    purpose: profile.ratePurpose,
    mode: "channel_managed",
    eligibilityMode: "channel",
    rateContext: null,
  };
}
