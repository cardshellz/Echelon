import { z } from "zod";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { invoiceWorkListPageSchema, paymentWorkListPageSchema, type InvoiceWorkListPage, type PaymentWorkListPage } from "@shared/procurement/ap-work-list";

type ListFilters = { search?: string; status?: string; vendorId?: string; overdue?: string; limit?: number; offset?: number };
function listUrl(path: string, filters: ListFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") params.set(key, String(value));
  return `${path}?${params}`;
}
async function getList(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error("The work list could not be loaded. Retry to get current records.");
  return response.json();
}
export const invoiceWorkListQuery = (filters: ListFilters) => ({
  queryKey: ["/api/vendor-invoices/work-list", filters] as const,
  staleTime: 0,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<InvoiceWorkListPage> => invoiceWorkListPageSchema.parse(await getList(listUrl("/api/vendor-invoices/work-list", filters), signal)),
});
export const paymentWorkListQuery = (filters: ListFilters) => ({
  queryKey: ["/api/ap-payments/work-list", filters] as const,
  staleTime: 0,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PaymentWorkListPage> => paymentWorkListPageSchema.parse(await getList(listUrl("/api/ap-payments/work-list", filters), signal)),
});
export function isApInvoiceQuery(queryKey: QueryKey): boolean {
  return typeof queryKey[0] === "string" && /^\/api\/vendor-invoices(?:[/?]|$)/.test(queryKey[0]);
}
export function isApPaymentQuery(queryKey: QueryKey): boolean {
  return typeof queryKey[0] === "string" && /^\/api\/ap-payments(?:[/?]|$)/.test(queryKey[0]);
}
// Match both legacy URL-string keys and structured work-list keys. A mounted payment
// dialog must see settlement/void changes even though the application's staleTime is Infinity.
export async function invalidateApInvoiceQueries(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ predicate: query => isApInvoiceQuery(query.queryKey) });
}
export async function invalidateApPaymentQueries(client: QueryClient): Promise<void> {
  await Promise.all([
    invalidateApInvoiceQueries(client),
    client.invalidateQueries({ predicate: query => isApPaymentQuery(query.queryKey) }),
    client.invalidateQueries({ queryKey: ["/api/ap/summary"] }),
    client.invalidateQueries({ predicate: query => typeof query.queryKey[0] === "string" && /^\/api\/ap\/command-events(?:[?]|$)/.test(query.queryKey[0]) }),
  ]);
}

const vendorOptionsSchema = z.array(z.object({ id: z.number().int().positive(), name: z.string() }).passthrough());
export const apVendorOptionsQuery = {
  queryKey: ["/api/vendors"],
  queryFn: async ({ signal }: { signal: AbortSignal }) => vendorOptionsSchema.parse(await getList("/api/vendors", signal)),
};
