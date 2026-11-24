export type LegacyHeaderPolicy = "strict" | "aggregate_projection";

export const PROVIDER_ORDER_IDENTITY_POLICIES = ["strict", "stable_key_alias"] as const;
export type ProviderOrderIdentityPolicy = typeof PROVIDER_ORDER_IDENTITY_POLICIES[number];

export type ProviderOrderIdResolution =
  | "compatible"
  | "known_alias"
  | "stable_key_alias"
  | "conflict";

export interface ResolveProviderOrderIdInput {
  readonly legacyHeaderPolicy: LegacyHeaderPolicy;
  readonly providerOrderIdentityPolicy?: ProviderOrderIdentityPolicy;
  readonly persistedProviderOrderId: string | null;
  readonly persistedProviderOrderKey: string | null;
  readonly incomingProviderOrderId: string | null;
  readonly incomingProviderOrderKey: string | null;
  readonly incomingProviderOrderIdAlreadyAliased: boolean;
}

function normalize(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

/**
 * A provider order key identifies stable logical shipping work. A provider may
 * create multiple order records for that work while splitting or recreating
 * physical packages. An alias-enabled caller may recognize a new order id once
 * the stable key is proven equal. Callers must reject contradictory order keys
 * even for saved aliases and enforce physical package identity independently.
 */
export function resolveProviderOrderId(
  input: ResolveProviderOrderIdInput,
): ProviderOrderIdResolution {
  const persistedId = normalize(input.persistedProviderOrderId);
  const incomingId = normalize(input.incomingProviderOrderId);
  if (!persistedId || !incomingId || persistedId === incomingId) {
    return "compatible";
  }
  if (input.incomingProviderOrderIdAlreadyAliased) {
    return "known_alias";
  }

  const persistedKey = normalize(input.persistedProviderOrderKey);
  const incomingKey = normalize(input.incomingProviderOrderKey);
  if (
    (input.legacyHeaderPolicy === "aggregate_projection"
      || input.providerOrderIdentityPolicy === "stable_key_alias")
    && persistedKey
    && incomingKey
    && persistedKey === incomingKey
  ) {
    return "stable_key_alias";
  }
  return "conflict";
}
