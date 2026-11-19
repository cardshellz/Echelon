import { useQuery } from "@tanstack/react-query";
import type { CustomerAccountTransport } from "./customer-account.transport";

/** The panel accordion and direct order page share the same owned, read-only
 * financial query. React Query deduplicates concurrent reads for this identity. */
export function useCustomerOrderDetails(
  api: CustomerAccountTransport,
  identity: { externalOrderId: string; orderReference: string },
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "customer-account-order-details",
      identity.externalOrderId,
      identity.orderReference,
    ],
    queryFn: ({ signal }) => api.orderDetails(identity, signal),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
