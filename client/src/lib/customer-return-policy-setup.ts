import { CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS } from "@shared/returns/customer-return-portal-policy";

export interface PortalPolicyChannel {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}

/** A query can prefill a review, never authorize a policy write or enable labels. */
export function resolvePortalPolicySetupChannel(
  search: string,
  channels: readonly PortalPolicyChannel[],
  dropshipOmsChannelId: number,
): PortalPolicyChannel | null {
  const values = new URLSearchParams(search).getAll("portalChannelId");
  if (values.length === 0) return null;
  const id = Number(values[0]);
  const matches = channels.filter((channel) => channel.id === id);
  if (
    values.length !== 1 ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !Number.isSafeInteger(id) ||
    matches.length !== 1 ||
    matches[0].status !== "active" ||
    matches[0].type !== "internal" ||
    matches[0].provider !== "shopify" ||
    id === dropshipOmsChannelId
  ) {
    throw new Error(
      "This setup link does not identify an active Shopify sales channel. Open setup from Return label settings.",
    );
  }
  return matches[0];
}

export function createPortalPolicyDraft(channel: PortalPolicyChannel) {
  return {
    name: `${channel.name} customer returns`.slice(0, 160),
    appliesTo: "channel" as const,
    channelId: channel.id,
    vendorId: null,
    storeConnectionId: null,
    ...CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS,
    notes: null,
  };
}

export type PortalPolicyDraft = ReturnType<typeof createPortalPolicyDraft>;
