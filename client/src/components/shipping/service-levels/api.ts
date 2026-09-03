import type { QueryClient } from "@tanstack/react-query";
import type { ServiceLevelOption } from "@/components/shipping/pricing-programs/api";
import type {
  ReplaceShippingFulfillmentRoutingInput,
  ReplaceShippingFulfillmentRoutingResult,
  ShippingFulfillmentRoutingAdminView,
} from "@shared/types/shipping-fulfillment-routing";
import {
  getJson,
  invalidateShippingAdmin,
  putJson,
} from "@/components/shipping/pricing-programs/api";

export interface ShippingServiceLevel extends ServiceLevelOption {
  sortOrder: number;
}

interface ShippingAdminConfigResponse {
  serviceLevels: ShippingServiceLevel[];
}

export interface ServiceLevelDetailsInput {
  displayName: string;
  description: string;
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  isActive: boolean;
}

export const SHIPPING_ADMIN_CONFIG_KEY = "/api/shipping/admin/config";

export function loadShippingServiceLevels(): Promise<ShippingAdminConfigResponse> {
  return getJson<ShippingAdminConfigResponse>(SHIPPING_ADMIN_CONFIG_KEY);
}

export function saveServiceLevelDetails(
  id: number,
  input: ServiceLevelDetailsInput,
): Promise<{ serviceLevel: ShippingServiceLevel }> {
  return putJson<{ serviceLevel: ShippingServiceLevel }>(
    `/api/shipping/admin/service-levels/${id}`,
    input,
  );
}

export function fulfillmentRoutingKey(serviceLevelId: number): string {
  return `/api/shipping/admin/service-levels/${serviceLevelId}/fulfillment-routing`;
}

export function loadFulfillmentRouting(
  serviceLevelId: number,
): Promise<ShippingFulfillmentRoutingAdminView> {
  return getJson<ShippingFulfillmentRoutingAdminView>(
    fulfillmentRoutingKey(serviceLevelId),
    { cache: "no-store" },
  );
}

export function saveFulfillmentRouting(
  serviceLevelId: number,
  input: ReplaceShippingFulfillmentRoutingInput,
): Promise<ReplaceShippingFulfillmentRoutingResult> {
  return putJson<ReplaceShippingFulfillmentRoutingResult>(
    fulfillmentRoutingKey(serviceLevelId),
    input,
  );
}

export function refreshShippingServiceLevels(queryClient: QueryClient): void {
  invalidateShippingAdmin(queryClient);
}

export function serviceLevelPromise(level: Pick<
  ShippingServiceLevel,
  "promiseMinBusinessDays" | "promiseMaxBusinessDays"
>): string {
  const min = level.promiseMinBusinessDays;
  const max = level.promiseMaxBusinessDays;
  if (min === null || max === null) return "Not set";
  if (min === max) return `${min} business ${min === 1 ? "day" : "days"}`;
  return `${min}-${max} business days`;
}

export function fulfillmentModeLabel(mode: ShippingServiceLevel["fulfillmentMode"]): string {
  return mode === "freight" ? "Pallet freight" : "Parcel";
}
