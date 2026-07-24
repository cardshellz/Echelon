import {
  and,
  asc,
  eq,
  inArray,
} from "drizzle-orm";
import {
  channels,
  shippingChannelPolicies,
  shippingChannelPolicyRouteDestinations,
  shippingChannelPolicyRoutes,
  shippingRateBooks,
} from "@shared/schema";
import type {
  ShippingChannelPolicyPurpose,
} from "@shared/types/shipping-channel-routing";
import { db } from "../../../db";
import type {
  ChannelShippingPolicyRuntimeStore,
  RuntimeShippingChannel,
} from "../application/channel-shipping-policy-runtime.service";
import type {
  ChannelShippingPolicyCandidate,
  DestinationScopeMemberCandidate,
} from "../domain/channel-shipping-policy";

export class PostgresChannelShippingPolicyRuntimeStore
implements ChannelShippingPolicyRuntimeStore {
  async getChannel(channelId: number): Promise<RuntimeShippingChannel | null> {
    const [channel] = await db
      .select({
        id: channels.id,
        provider: channels.provider,
        status: channels.status,
        isDefault: channels.isDefault,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return channel ?? null;
  }

  async loadActivePolicies(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ChannelShippingPolicyCandidate[]> {
    const policies = await db
      .select({
        policyId: shippingChannelPolicies.id,
        channelId: shippingChannelPolicies.channelId,
        purpose: shippingChannelPolicies.purpose,
        version: shippingChannelPolicies.version,
        status: shippingChannelPolicies.status,
      })
      .from(shippingChannelPolicies)
      .where(and(
        eq(shippingChannelPolicies.channelId, channelId),
        eq(shippingChannelPolicies.purpose, purpose),
        eq(shippingChannelPolicies.status, "active"),
      ))
      .orderBy(asc(shippingChannelPolicies.id));
    if (policies.length === 0) return [];

    const policyIds = policies.map((policy) => policy.policyId);
    const routes = await db
      .select({
        routeId: shippingChannelPolicyRoutes.id,
        policyId: shippingChannelPolicyRoutes.policyId,
        originWarehouseId:
          shippingChannelPolicyRoutes.originWarehouseId,
        sourceDestinationScopeId:
          shippingChannelPolicyRoutes.sourceDestinationScopeId,
        mode: shippingChannelPolicyRoutes.mode,
        eligibilityMode:
          shippingChannelPolicyRoutes.eligibilityMode,
        rateBookId: shippingChannelPolicyRoutes.rateBookId,
        rateBookStatus: shippingRateBooks.status,
      })
      .from(shippingChannelPolicyRoutes)
      .leftJoin(
        shippingRateBooks,
        eq(shippingRateBooks.id, shippingChannelPolicyRoutes.rateBookId),
      )
      .where(inArray(shippingChannelPolicyRoutes.policyId, policyIds))
      .orderBy(asc(shippingChannelPolicyRoutes.id));
    const routeIds = routes.map((route) => route.routeId);
    const destinations = routeIds.length === 0
      ? []
      : await db
          .select({
            routeId: shippingChannelPolicyRouteDestinations.routeId,
            country:
              shippingChannelPolicyRouteDestinations.destinationCountry,
            region:
              shippingChannelPolicyRouteDestinations.destinationRegion,
            postalPrefix:
              shippingChannelPolicyRouteDestinations.postalPrefix,
          })
          .from(shippingChannelPolicyRouteDestinations)
          .where(inArray(
            shippingChannelPolicyRouteDestinations.routeId,
            routeIds,
          ))
          .orderBy(
            asc(shippingChannelPolicyRouteDestinations.routeId),
            asc(
              shippingChannelPolicyRouteDestinations.destinationCountry,
            ),
            asc(
              shippingChannelPolicyRouteDestinations.destinationRegion,
            ),
            asc(shippingChannelPolicyRouteDestinations.postalPrefix),
          );
    const destinationsByRoute = groupDestinations(destinations);
    const routesByPolicy = new Map<
      number,
      ChannelShippingPolicyCandidate["routes"][number][]
    >();
    for (const route of routes) {
      const candidates = routesByPolicy.get(route.policyId) ?? [];
      candidates.push({
        routeId: route.routeId,
        originWarehouseId: route.originWarehouseId,
        sourceDestinationScopeId: route.sourceDestinationScopeId,
        destinationMembers:
          destinationsByRoute.get(route.routeId) ?? [],
        mode: route.mode,
        eligibilityMode: route.eligibilityMode,
        rateBookId: route.rateBookId,
        rateBookStatus: normalizeRateBookStatus(route.rateBookStatus),
      });
      routesByPolicy.set(route.policyId, candidates);
    }

    return policies.map((policy) => ({
      ...policy,
      routes: routesByPolicy.get(policy.policyId) ?? [],
    }));
  }
}

function groupDestinations(
  rows: Array<{
    routeId: number;
    country: string;
    region: string | null;
    postalPrefix: string | null;
  }>,
): Map<number, DestinationScopeMemberCandidate[]> {
  const byRoute = new Map<number, DestinationScopeMemberCandidate[]>();
  for (const row of rows) {
    const members = byRoute.get(row.routeId) ?? [];
    members.push({
      country: row.country,
      region: row.region,
      postalPrefix: row.postalPrefix,
    });
    byRoute.set(row.routeId, members);
  }
  return byRoute;
}

function normalizeRateBookStatus(
  status: string | null,
): "draft" | "active" | "retired" | null {
  return status === "draft" || status === "active" || status === "retired"
    ? status
    : null;
}
