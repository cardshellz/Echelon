import {
  customerReturnLabelSettingsInputSchema,
  type CustomerReturnLabelSettingsInput,
  type CustomerReturnLabelSettingsState,
} from "@shared/returns/customer-return-label.contract";

export const RETURN_LABEL_SETTINGS_PATH = "/returns/label-settings";
// Initial merchant preference only; the saved per-account rule is authoritative.
const DEFAULT_USPS_RETURN_MAX_WEIGHT_LB = "20";

export interface ReturnCarrierRuleDraft {
  carrierId: string;
  enabled: boolean;
  serviceCodes: string[];
  maxWeightLb: string;
}
export interface ReturnLabelSettingsDraft {
  warehouseId: string;
  policyId: string;
  selectionMode: "fixed_service" | "cheapest_eligible";
  carrierId: string;
  serviceCode: string;
  carrierRules: ReturnCarrierRuleDraft[];
  contactName: string;
  contactPhone: string;
  enabled: boolean;
}

export function createReturnLabelSettingsDraft(
  state: CustomerReturnLabelSettingsState,
): ReturnLabelSettingsDraft {
  const settings = state.settings;
  const rules = settings?.carrierRules ?? [];
  const carrierIds = new Set([
    ...state.carriers.map((carrier) => carrier.id),
    ...rules.map((rule) => rule.carrierId),
  ]);
  return {
    warehouseId: settings ? String(settings.warehouseId) : "",
    policyId: settings ? String(settings.policyId) : "",
    selectionMode: settings?.selectionMode ?? "cheapest_eligible",
    carrierId: settings?.carrierId ?? "",
    serviceCode: settings?.serviceCode ?? "",
    carrierRules: [...carrierIds].map((carrierId) => {
      const rule = rules.find((candidate) => candidate.carrierId === carrierId);
      const carrier = state.carriers.find(
        (candidate) => candidate.id === carrierId,
      );
      const usps = carrier?.code === "usps" || carrier?.code === "stamps_com";
      return {
        carrierId,
        enabled: Boolean(rule),
        serviceCodes: [...(rule?.serviceCodes ?? [])],
        // This is an editable business limit, not a carrier's technical maximum.
        maxWeightLb: rule
          ? (rule.maxWeightLb ?? "")
          : usps
            ? DEFAULT_USPS_RETURN_MAX_WEIGHT_LB
            : "",
      };
    }),
    contactName: settings?.contactName ?? "",
    contactPhone: settings?.contactPhone ?? "",
    enabled: settings?.enabled ?? false,
  };
}

export function parseReturnLabelSettingsDraft(
  draft: ReturnLabelSettingsDraft,
  expectedVersion: number,
) {
  const automatic = draft.selectionMode === "cheapest_eligible";
  return customerReturnLabelSettingsInputSchema.safeParse({
    expectedVersion,
    enabled: draft.enabled,
    warehouseId: Number(draft.warehouseId),
    policyId: Number(draft.policyId),
    selectionMode: draft.selectionMode,
    carrierId: automatic ? null : draft.carrierId,
    serviceCode: automatic ? null : draft.serviceCode,
    carrierRules: automatic
      ? draft.carrierRules
          .filter((rule) => rule.enabled)
          .map((rule) => ({
            carrierId: rule.carrierId,
            serviceCodes: [...rule.serviceCodes],
            maxWeightLb: rule.maxWeightLb.trim() || null,
          }))
      : [],
    contactName: draft.contactName,
    contactPhone: draft.contactPhone.trim() || null,
  });
}

export function returnLabelConfigurationAvailable(
  settings: Omit<CustomerReturnLabelSettingsInput, "expectedVersion">,
  state: CustomerReturnLabelSettingsState,
): boolean {
  if (
    !state.providerConfigured ||
    !state.warehouses.some(
      (warehouse) =>
        warehouse.id === settings.warehouseId && warehouse.address !== null,
    ) ||
    !state.policies.some((policy) => policy.id === settings.policyId)
  )
    return false;
  if (settings.selectionMode === "fixed_service") {
    return state.carriers.some(
      (carrier) =>
        carrier.id === settings.carrierId &&
        carrier.services.some(
          (service) => service.code === settings.serviceCode,
        ),
    );
  }
  return (
    settings.carrierRules.length > 0 &&
    settings.carrierRules.every((rule) => {
      const carrier = state.carriers.find(
        (candidate) => candidate.id === rule.carrierId,
      );
      return (
        carrier &&
        rule.serviceCodes.length > 0 &&
        rule.serviceCodes.every((code) =>
          carrier.services.some((service) => service.code === code),
        )
      );
    })
  );
}

/** Query state selects a known shop; it never creates authority or a redirect URL. */
export function selectedReturnSettingsChannel(
  search: string,
  shops: readonly { channelId: number }[],
): string {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("channelId");
  if (values.length === 0)
    return shops.length === 1 ? String(shops[0].channelId) : "";
  if (
    values.length !== 1 ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !Number.isSafeInteger(Number(values[0])) ||
    !shops.some((shop) => shop.channelId === Number(values[0]))
  ) {
    throw new Error(
      "The requested Shopify shop is unavailable. Choose a configured shop below.",
    );
  }
  return values[0];
}
