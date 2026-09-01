import type {
  ShippingFulfillmentRouteMethod,
  ShippingFulfillmentRoutingProfile,
} from "@shared/types/shipping-fulfillment-routing";

export type FulfillmentRouteScope = "domestic" | "international";

export type FulfillmentRouteResolution =
  | {
      ok: true;
      serviceLevelId: number;
      profileRevision: number;
      scope: FulfillmentRouteScope;
      candidates: ShippingFulfillmentRouteMethod[];
    }
  | {
      ok: false;
      serviceLevelId: number;
      profileRevision: number;
      scope: FulfillmentRouteScope;
      code:
        | "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED"
        | "SHIPPING_FULFILLMENT_ROUTING_NO_ELIGIBLE_METHODS"
        | "SHIPPING_FULFILLMENT_ROUTING_PROFILE_INVALID";
      message: string;
    };

/**
 * Resolves an ordered candidate set, not a purchased label. A fulfillment
 * caller must still rate/validate candidates and record which exact method it
 * chose. Keeping this function pure makes every channel use the same fail-
 * closed routing semantics without importing provider or database concerns.
 */
export function resolveFulfillmentRouteCandidates(
  profile: ShippingFulfillmentRoutingProfile,
  scope: FulfillmentRouteScope,
): FulfillmentRouteResolution {
  if (
    !Number.isInteger(profile.serviceLevelId)
    || profile.serviceLevelId <= 0
    || !Number.isInteger(profile.revision)
    || profile.revision < 0
  ) {
    return failure(profile, scope, "SHIPPING_FULFILLMENT_ROUTING_PROFILE_INVALID",
      "The fulfillment routing profile identity or revision is invalid.");
  }
  if (profile.revision === 0 || profile.methods.length === 0) {
    return failure(profile, scope, "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED",
      "No fulfillment methods are configured for this service level.");
  }

  const ordered = [...profile.methods].sort((left, right) => left.priority - right.priority);
  if (!hasCoherentPriorities(ordered)) {
    return failure(profile, scope, "SHIPPING_FULFILLMENT_ROUTING_PROFILE_INVALID",
      "Fulfillment method priorities are incomplete or duplicated.");
  }
  const candidates = ordered.filter((method) => (
    scope === "domestic" ? method.domestic : method.international
  ));
  if (candidates.length === 0) {
    return failure(profile, scope, "SHIPPING_FULFILLMENT_ROUTING_NO_ELIGIBLE_METHODS",
      `No configured fulfillment method supports ${scope} shipments.`);
  }
  return {
    ok: true,
    serviceLevelId: profile.serviceLevelId,
    profileRevision: profile.revision,
    scope,
    candidates: candidates.map((method) => ({ ...method })),
  };
}

function hasCoherentPriorities(
  methods: readonly ShippingFulfillmentRouteMethod[],
): boolean {
  return methods.every((method, index) => (
    Number.isInteger(method.priority) && method.priority === index + 1
  ));
}

function failure(
  profile: ShippingFulfillmentRoutingProfile,
  scope: FulfillmentRouteScope,
  code: Extract<FulfillmentRouteResolution, { ok: false }>["code"],
  message: string,
): Extract<FulfillmentRouteResolution, { ok: false }> {
  return {
    ok: false,
    serviceLevelId: profile.serviceLevelId,
    profileRevision: profile.revision,
    scope,
    code,
    message,
  };
}
