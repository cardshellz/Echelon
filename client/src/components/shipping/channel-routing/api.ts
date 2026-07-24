import type { QueryClient } from "@tanstack/react-query";
import type {
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicyResolutionView,
  ShippingChannelPolicyRouteInput,
  ShippingChannelPolicyShadowComparison,
  ShippingChannelPolicyView,
  ShippingChannelRoutingOverview,
  ShippingDestinationScopeMember,
  ShippingDestinationScopeSummary,
  ShippingLegacyProfileKey,
} from "@shared/types/shipping-channel-routing";

export const CHANNEL_ROUTING_KEY = "/api/shipping/admin/channel-routing";

export function channelPolicyKey(policyId: number): string {
  return `/api/shipping/admin/channel-policies/${policyId}`;
}

export async function loadChannelRouting(): Promise<ShippingChannelRoutingOverview> {
  return requestJson(CHANNEL_ROUTING_KEY);
}

export async function loadChannelPolicy(
  policyId: number,
): Promise<ShippingChannelPolicyView> {
  return requestJson(channelPolicyKey(policyId));
}

export async function createChannelPolicyDraft(input: {
  channelId: number;
  purpose: ShippingChannelPolicyPurpose;
  cloneActive: boolean;
  notes: string | null;
}): Promise<ShippingChannelPolicyView> {
  return requestJson("/api/shipping/admin/channel-policies/drafts", {
    method: "POST",
    body: input,
  });
}

export async function saveChannelPolicyDraft(input: {
  policyId: number;
  expectedLockVersion: number;
  notes: string | null;
  routes: ShippingChannelPolicyRouteInput[];
}): Promise<ShippingChannelPolicyView> {
  return requestJson(`${channelPolicyKey(input.policyId)}/draft`, {
    method: "PUT",
    body: {
      expectedLockVersion: input.expectedLockVersion,
      notes: input.notes,
      routes: input.routes,
    },
  });
}

export async function activateChannelPolicy(input: {
  policyId: number;
  expectedLockVersion: number;
}): Promise<ShippingChannelPolicyView> {
  return requestJson(`${channelPolicyKey(input.policyId)}/activate`, {
    method: "POST",
    body: { expectedLockVersion: input.expectedLockVersion },
  });
}

export async function discardChannelPolicyDraft(input: {
  policyId: number;
  expectedLockVersion: number;
}): Promise<ShippingChannelPolicyView> {
  return requestJson(`${channelPolicyKey(input.policyId)}/discard`, {
    method: "POST",
    body: { expectedLockVersion: input.expectedLockVersion },
  });
}

export async function retireChannelPolicy(input: {
  policyId: number;
  expectedLockVersion: number;
}): Promise<ShippingChannelPolicyView> {
  return requestJson(`${channelPolicyKey(input.policyId)}/retire`, {
    method: "POST",
    body: { expectedLockVersion: input.expectedLockVersion },
  });
}

export async function previewChannelPolicy(input: {
  policyId: number;
  originWarehouseId: number;
  destination: {
    country: string;
    region: string | null;
    postalCode: string | null;
  };
}): Promise<ShippingChannelPolicyResolutionView> {
  return requestJson(`${channelPolicyKey(input.policyId)}/preview`, {
    method: "POST",
    body: {
      originWarehouseId: input.originWarehouseId,
      destination: input.destination,
    },
  });
}

export async function compareChannelPolicyToLegacy(input: {
  policyId: number;
  originWarehouseId: number;
  destination: {
    country: string;
    region: string | null;
    postalCode: string | null;
  };
  legacyProfile: ShippingLegacyProfileKey;
}): Promise<ShippingChannelPolicyShadowComparison> {
  return requestJson(`${channelPolicyKey(input.policyId)}/shadow-compare`, {
    method: "POST",
    body: {
      originWarehouseId: input.originWarehouseId,
      destination: input.destination,
      legacyProfile: input.legacyProfile,
    },
  });
}

export async function createDeliveryRegion(input: {
  code: string;
  name: string;
  members: ShippingDestinationScopeMember[];
}): Promise<ShippingDestinationScopeSummary> {
  return requestJson("/api/shipping/admin/destination-scopes", {
    method: "POST",
    body: input,
  });
}

export async function updateDeliveryRegion(input: {
  scopeId: number;
  expectedLockVersion: number;
  code: string;
  name: string;
  members: ShippingDestinationScopeMember[];
}): Promise<ShippingDestinationScopeSummary> {
  return requestJson(`/api/shipping/admin/destination-scopes/${input.scopeId}`, {
    method: "PUT",
    body: {
      expectedLockVersion: input.expectedLockVersion,
      code: input.code,
      name: input.name,
      members: input.members,
    },
  });
}

export async function retireDeliveryRegion(input: {
  scopeId: number;
  expectedLockVersion: number;
}): Promise<ShippingDestinationScopeSummary> {
  return requestJson(
    `/api/shipping/admin/destination-scopes/${input.scopeId}/retire`,
    {
      method: "POST",
      body: { expectedLockVersion: input.expectedLockVersion },
    },
  );
}

export function updateRoutingCaches(
  queryClient: QueryClient,
  policy?: ShippingChannelPolicyView,
): void {
  if (policy) {
    queryClient.setQueryData([channelPolicyKey(policy.id)], policy);
  }
  void queryClient.invalidateQueries({ queryKey: [CHANNEL_ROUTING_KEY] });
}

interface RequestOptions {
  method: "POST" | "PUT";
  body: unknown;
}

async function requestJson<T>(
  url: string,
  options?: RequestOptions,
): Promise<T> {
  const response = await fetch(url, {
    method: options?.method ?? "GET",
    credentials: "include",
    headers: options ? { "Content-Type": "application/json" } : undefined,
    body: options ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw apiError(body, response.status);
  }
  return body as T;
}

function apiError(body: unknown, status: number): Error {
  if (body && typeof body === "object" && "error" in body) {
    const payload = (body as {
      error?: { message?: unknown; details?: unknown } | string;
    }).error;
    if (typeof payload === "string") return new Error(payload);
    if (payload && typeof payload.message === "string") {
      const details = Array.isArray(payload.details)
        ? payload.details.filter((item): item is string => typeof item === "string")
        : [];
      return new Error([payload.message, ...details].join("\n"));
    }
  }
  return new Error(`Request failed (${status}).`);
}
