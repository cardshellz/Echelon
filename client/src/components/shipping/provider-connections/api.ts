import type {
  ChangeShippingFulfillmentProviderConnectionStatusInput,
  CreateShippingFulfillmentProviderConnectionInput,
  ReplaceShippingFulfillmentProviderCredentialInput,
  ShippingFulfillmentProviderConnectionMutationResult,
  ShippingFulfillmentProviderConnectionsAdminView,
  VerifyShippingFulfillmentProviderConnectionInput,
} from "@shared/types/shipping-fulfillment-routing";
import { getJson, postJson, putJson } from "../pricing-programs/api";

export const FULFILLMENT_PROVIDER_CONNECTIONS_KEY =
  "/api/shipping/admin/fulfillment-provider-connections";

export function loadFulfillmentProviderConnections(): Promise<
ShippingFulfillmentProviderConnectionsAdminView
> {
  return getJson(FULFILLMENT_PROVIDER_CONNECTIONS_KEY);
}

export function createFulfillmentProviderConnection(
  input: CreateShippingFulfillmentProviderConnectionInput,
): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
  return postJson(FULFILLMENT_PROVIDER_CONNECTIONS_KEY, input);
}

export function replaceFulfillmentProviderCredential(
  connectionId: number,
  input: ReplaceShippingFulfillmentProviderCredentialInput,
): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
  return putJson(
    `${FULFILLMENT_PROVIDER_CONNECTIONS_KEY}/${connectionId}/credential`,
    input,
  );
}

export function verifyFulfillmentProviderConnection(
  connectionId: number,
  input: VerifyShippingFulfillmentProviderConnectionInput,
): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
  return postJson(
    `${FULFILLMENT_PROVIDER_CONNECTIONS_KEY}/${connectionId}/verify`,
    input,
  );
}

export function changeFulfillmentProviderConnectionStatus(
  connectionId: number,
  enabled: boolean,
  input: ChangeShippingFulfillmentProviderConnectionStatusInput,
): Promise<ShippingFulfillmentProviderConnectionMutationResult> {
  return postJson(
    `${FULFILLMENT_PROVIDER_CONNECTIONS_KEY}/${connectionId}/${enabled ? "enable" : "disable"}`,
    input,
  );
}
