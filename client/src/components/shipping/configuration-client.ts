import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  packagingConfigurationSchema,
  type FulfillmentChannel,
} from "@shared/shipping/configuration";
import { getJson } from "./pricing-programs/api";

export const PACKAGING_KEY = "/api/shipping/admin/packaging";
export const channelLabels: Record<FulfillmentChannel, string> = {
  dropship: "Dropship",
  shopify: "Shopify",
  ebay: "eBay",
  internal: "Internal orders",
};
export function usePackagingConfiguration() {
  return useQuery({
    queryKey: [PACKAGING_KEY],
    queryFn: async () =>
      packagingConfigurationSchema.parse(await getJson(PACKAGING_KEY)),
  });
}
export function useConfigurationCommand() {
  const command = useRef<{ body: string; id: string } | undefined>(undefined);
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (command.current?.body !== serialized)
      command.current = { body: serialized, id: crypto.randomUUID() };
    return command.current.id;
  };
}
export function packagingAssignmentUrl(channel: FulfillmentChannel): string {
  return `/shipping-settings?tab=channel-routing&section=packaging&profile=${channel}`;
}
