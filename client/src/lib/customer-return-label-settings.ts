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
  selectionMode: "fixed_service" | "cheapest_eligible";
  carrierId: string;
  serviceCode: string;
  carrierRules: ReturnCarrierRuleDraft[];
  contactName: string;
  contactPhone: string;
  enabled: boolean;
}

export type ReturnLabelSettingsField =
  | "warehouseId"
  | "contactName"
  | "contactPhone"
  | "carrierId"
  | "serviceCode"
  | "carrierRules";

export interface ReturnLabelSettingsIssue {
  field: ReturnLabelSettingsField | null;
  message: string;
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

/** A catalog refresh updates authority, not an administrator's unsaved choices. */
export function refreshReturnLabelSettingsDraft(
  draft: ReturnLabelSettingsDraft,
  state: CustomerReturnLabelSettingsState,
): ReturnLabelSettingsDraft {
  const discovered = createReturnLabelSettingsDraft({
    ...state,
    settings: null,
  });
  const knownIds = new Set(draft.carrierRules.map((rule) => rule.carrierId));
  return {
    ...draft,
    carrierRules: [
      ...draft.carrierRules.map((rule) => ({
        ...rule,
        serviceCodes: [...rule.serviceCodes],
      })),
      ...discovered.carrierRules.filter(
        (rule) => !knownIds.has(rule.carrierId),
      ),
    ],
  };
}

/** Keep the Save gate and its explanation derived from the same fresh state. */
export function returnLabelSettingsReadiness(
  draft: ReturnLabelSettingsDraft,
  state: CustomerReturnLabelSettingsState,
) {
  const parsed = parseReturnLabelSettingsDraft(
    draft,
    state.settings?.version ?? 0,
  );
  const issues: ReturnLabelSettingsIssue[] = [];
  function add(field: ReturnLabelSettingsField | null, message: string) {
    if (
      !issues.some(
        (issue) => issue.field === field && issue.message === message,
      )
    )
      issues.push({ field, message });
  }

  if (!state.providerConfigured)
    add(
      null,
      state.message ??
        "The shipping provider is unavailable. Refresh label settings before saving.",
    );

  const warehouse = state.warehouses.find(
    (item) => item.id === Number(draft.warehouseId),
  );
  if (!draft.warehouseId)
    add(
      "warehouseId",
      "Choose a return warehouse with a complete U.S. address.",
    );
  else if (!warehouse?.address)
    add(
      "warehouseId",
      "The selected warehouse is unavailable or needs a complete U.S. address.",
    );

  const enabledRules = draft.carrierRules.filter((rule) => rule.enabled);
  if (draft.selectionMode === "fixed_service") {
    const carrier = state.carriers.find((item) => item.id === draft.carrierId);
    if (!carrier) add("carrierId", "Choose an available return carrier.");
    if (!carrier?.services.some((item) => item.code === draft.serviceCode))
      add("serviceCode", "Choose an available return service.");
  } else {
    if (enabledRules.length === 0)
      add(
        "carrierRules",
        "Allow at least one carrier and choose its return services.",
      );
    for (const rule of enabledRules) {
      const carrier = state.carriers.find((item) => item.id === rule.carrierId);
      if (!carrier)
        add(
          "carrierRules",
          `The allowed account ${rule.carrierId} is unavailable. Disable it or refresh label settings.`,
        );
      else if (rule.serviceCodes.length === 0)
        add(
          "carrierRules",
          `Choose at least one return service for ${carrier.name} (${carrier.id}).`,
        );
      else if (
        rule.serviceCodes.some(
          (code) => !carrier.services.some((service) => service.code === code),
        )
      )
        add(
          "carrierRules",
          `Remove unavailable return services from ${carrier.name} (${carrier.id}).`,
        );
    }
  }

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "contactName")
        add(
          "contactName",
          draft.contactName.trim()
            ? "Use a receiving contact name of 1–200 characters without control characters."
            : "Enter the receiving contact name.",
        );
      else if (field === "contactPhone")
        add(
          "contactPhone",
          "Use a phone number of up to 50 characters without control characters, or leave it blank.",
        );
      else if (field === "carrierRules" && issue.path[2] === "maxWeightLb") {
        const rule = enabledRules[Number(issue.path[1])];
        const name =
          state.carriers.find((item) => item.id === rule?.carrierId)?.name ??
          rule?.carrierId ??
          "this account";
        add(
          "carrierRules",
          `Enter a positive maximum weight with up to three decimal places for ${name}, or leave it blank.`,
        );
      } else if (!issues.some((existing) => existing.field === field)) {
        add(
          null,
          "Review the required fields and allowed carrier rules before saving.",
        );
      }
    }
  }

  const canSave =
    parsed.success && returnLabelConfigurationAvailable(parsed.data, state);
  if (!canSave && issues.length === 0)
    add(
      null,
      "The configuration could not be verified. Refresh label settings before saving.",
    );
  return { parsed, canSave, issues };
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
    )
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
