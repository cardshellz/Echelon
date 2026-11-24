import type {
  ShippingChannelAdapterCapabilities,
} from "@shared/types/shipping-channel-routing";

export interface ChannelShippingCapabilityDeclaration {
  readonly providerKey: string;
  readonly shippingCapabilities: ShippingChannelAdapterCapabilities;
}

export interface ChannelShippingCapabilityResolver {
  resolve(
    providerKey: string,
  ): ShippingChannelAdapterCapabilities | null;
}

/**
 * Runtime registry for code capabilities declared by channel adapters.
 * Configuration can select only behavior the registered adapter can enforce.
 */
export class ChannelShippingCapabilityRegistry
  implements ChannelShippingCapabilityResolver {
  private readonly capabilitiesByProvider = new Map<
    string,
    ShippingChannelAdapterCapabilities
  >();

  register(declaration: ChannelShippingCapabilityDeclaration): void {
    const providerKey = normalizeProviderKey(declaration.providerKey);
    if (this.capabilitiesByProvider.has(providerKey)) {
      throw new Error(
        `Shipping capabilities already registered for provider "${providerKey}"`,
      );
    }
    this.capabilitiesByProvider.set(
      providerKey,
      freezeCapabilities(declaration.shippingCapabilities),
    );
  }

  resolve(providerKey: string): ShippingChannelAdapterCapabilities | null {
    const normalized = providerKey.trim().toLowerCase();
    if (normalized === "") return null;
    return this.capabilitiesByProvider.get(normalized) ?? null;
  }

  registeredProviders(): string[] {
    return [...this.capabilitiesByProvider.keys()];
  }
}

/**
 * Manual channels have no external checkout. Echelon may calculate an
 * internal charge, but there is no channel rate or destination control plane.
 */
export const MANUAL_CHANNEL_SHIPPING_CAPABILITY_DECLARATION:
  ChannelShippingCapabilityDeclaration = Object.freeze({
    providerKey: "manual",
    shippingCapabilities: Object.freeze({
      acceptsEngineQuotes: true,
      managesOwnRates: false,
      enforcesDestinationEligibility: false,
    }),
  });

function normalizeProviderKey(providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("Shipping capability provider key is required.");
  }
  return normalized;
}

function freezeCapabilities(
  capabilities: ShippingChannelAdapterCapabilities,
): ShippingChannelAdapterCapabilities {
  return Object.freeze({
    acceptsEngineQuotes: capabilities.acceptsEngineQuotes,
    managesOwnRates: capabilities.managesOwnRates,
    enforcesDestinationEligibility:
      capabilities.enforcesDestinationEligibility,
  });
}
