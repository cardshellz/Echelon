import {
  changeSalesStatusRequestSchema,
  salesStatusChangeResultSchema,
  salesStatusListSchema,
  salesStatusProductViewSchema,
  type ChangeSalesStatusRequest,
  type SalesStatusChangeResult,
  type SalesStatusList,
  type SalesStatusProductView,
} from "@shared/types/inventory-sales-status";

import { jsonInit, requestJson } from "./api";

/** HTTP boundary for the all-channels sales status. Responses are parsed against the shared contract. */
const BASE = "/api/inventory-planning/admin/sales-status";

export const SALES_STATUS_ENDPOINTS = {
  product: (productId: number) => `${BASE}/products/${productId}`,
  entries: `${BASE}/entries`,
  changes: `${BASE}/changes`,
} as const;

/** Every sales status query key starts with this, so one invalidation refreshes them all. */
export const SALES_STATUS_QUERY_ROOT = [BASE] as const;

export function fetchSalesStatusProduct(productId: number, signal?: AbortSignal): Promise<SalesStatusProductView> {
  return requestJson(SALES_STATUS_ENDPOINTS.product(productId), salesStatusProductViewSchema, { signal });
}

export function fetchStoppedSalesStatuses(signal?: AbortSignal): Promise<SalesStatusList> {
  return requestJson(`${SALES_STATUS_ENDPOINTS.entries}?status=stopped`, salesStatusListSchema, { signal });
}

export function changeSalesStatus(request: ChangeSalesStatusRequest): Promise<SalesStatusChangeResult> {
  return requestJson(SALES_STATUS_ENDPOINTS.changes, salesStatusChangeResultSchema,
    jsonInit("POST", changeSalesStatusRequestSchema.parse(request)));
}
