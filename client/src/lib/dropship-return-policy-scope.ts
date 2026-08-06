import {
  formatStatus,
  type DropshipAdminStoreConnectionListItem,
  type DropshipDogfoodReadinessItem,
} from "./dropship-ops-surface";

/**
 * Scope pickers for the dropship return-policy admin surface.
 *
 * The return-policy admin forms (policy versions, fee versions, effective
 * readout) scope rows by vendor id + store connection id. Operators think in
 * business names and store names, not numeric ids, so these helpers build
 * searchable select options from the admin ops data the page already loads.
 *
 * Blank-scope semantics (preserved from the raw-id inputs these replace):
 *   - vendor "" + store ""  -> global policy
 *   - vendor set + store "" -> vendor-only scope
 *   - vendor "" + store set -> rejected by the form (stores belong to vendors)
 *
 * The blank choices are rendered as explicit options with sentinel values
 * (cmdk CommandItem values must be non-empty), and the picker maps the
 * sentinel back to "" on selection.
 */

export interface ReturnPolicyScopeOption {
  value: string;
  label: string;
  detail?: string;
  search?: string;
}

/** Sentinel option value for "Global (no vendor)" in the vendor picker. */
export const RETURN_POLICY_GLOBAL_VENDOR_VALUE = "__global_vendor__";
/** Sentinel option value for "Any store" in the store picker. */
export const RETURN_POLICY_ANY_STORE_VALUE = "__any_store__";

type ReturnPolicyVendorSource = Pick<
  DropshipDogfoodReadinessItem,
  "vendor"
>["vendor"];

type ReturnPolicyStoreSource = Pick<
  DropshipAdminStoreConnectionListItem,
  "storeConnectionId" | "platform" | "status" | "externalDisplayName" | "shopDomain" | "vendor"
>;

export function returnPolicyVendorDisplayName(vendor: ReturnPolicyVendorSource): string {
  return vendor.businessName || vendor.email || `Vendor ${vendor.vendorId}`;
}

export function returnPolicyStoreDisplayName(connection: ReturnPolicyStoreSource): string {
  return (
    connection.externalDisplayName
    || connection.shopDomain
    || `${formatStatus(connection.platform)} store`
  );
}

/**
 * Map a picker value back to the form-state string ("" = blank/global).
 * Sentinel values for the explicit blank options collapse to "".
 */
export function returnPolicyScopeValueFromPicker(value: string): string {
  if (value === RETURN_POLICY_GLOBAL_VENDOR_VALUE || value === RETURN_POLICY_ANY_STORE_VALUE) {
    return "";
  }
  return value;
}

/**
 * Map form-state ("" = blank) to the picker value so the trigger shows the
 * blank option's label instead of the placeholder.
 */
export function returnPolicyScopeValueToPicker(
  value: string,
  blankSentinel: typeof RETURN_POLICY_GLOBAL_VENDOR_VALUE | typeof RETURN_POLICY_ANY_STORE_VALUE,
): string {
  return value.trim() === "" ? blankSentinel : value;
}

/**
 * Vendor options for the scope pickers, deduped by vendor id and sorted by
 * display name. Always starts with the explicit "Global (no vendor)" blank
 * option so the global scope is discoverable without clearing a selection.
 */
export function buildReturnPolicyVendorOptions(
  items: Array<Pick<DropshipDogfoodReadinessItem, "vendor">>,
): ReturnPolicyScopeOption[] {
  const vendors = new Map<number, ReturnPolicyVendorSource>();
  for (const item of items) {
    vendors.set(item.vendor.vendorId, item.vendor);
  }
  const vendorOptions = Array.from(vendors.values())
    .sort((first, second) => (
      returnPolicyVendorDisplayName(first).localeCompare(returnPolicyVendorDisplayName(second))
    ))
    .map((vendor) => {
      const label = returnPolicyVendorDisplayName(vendor);
      return {
        value: String(vendor.vendorId),
        label,
        detail: vendor.email && vendor.email !== label ? vendor.email : undefined,
        search: [
          vendor.vendorId,
          vendor.businessName,
          vendor.email,
          vendor.memberId,
          vendor.status,
        ].filter(Boolean).join(" "),
      };
    });
  return [
    {
      value: RETURN_POLICY_GLOBAL_VENDOR_VALUE,
      label: "Global (no vendor)",
      detail: "Policy applies unless a vendor/store-scoped row wins",
      search: "global default no vendor",
    },
    ...vendorOptions,
  ];
}

/**
 * Store options for the scope pickers.
 *
 * When `selectedVendorId` is a non-empty vendor id string, only that vendor's
 * store connections are returned and the leading blank option reads "Any
 * store" (vendor-only scope). When no vendor is selected, all connections are
 * returned with the vendor name in the label, and the leading blank option
 * reads "Global (no store)".
 */
export function buildReturnPolicyStoreOptions(
  connections: ReturnPolicyStoreSource[],
  selectedVendorId: string,
): ReturnPolicyScopeOption[] {
  const vendorIdFilter = selectedVendorId.trim() === "" ? null : Number(selectedVendorId);
  const filtered = vendorIdFilter === null
    ? connections
    : connections.filter((connection) => connection.vendor.vendorId === vendorIdFilter);

  const storeOptions = filtered
    .slice()
    .sort((first, second) => {
      const labelCompare = returnPolicyStoreDisplayName(first).localeCompare(returnPolicyStoreDisplayName(second));
      return labelCompare !== 0 ? labelCompare : first.storeConnectionId - second.storeConnectionId;
    })
    .map((connection) => {
      const storeLabel = returnPolicyStoreDisplayName(connection);
      const vendorLabel = returnPolicyVendorDisplayName(connection.vendor);
      const platformLabel = formatStatus(connection.platform);
      return {
        value: String(connection.storeConnectionId),
        label: vendorIdFilter === null
          ? `${platformLabel} — ${storeLabel} (${vendorLabel})`
          : `${platformLabel} — ${storeLabel}`,
        detail: vendorIdFilter === null
          ? `ID ${connection.storeConnectionId} / ${formatStatus(connection.status)}`
          : `${vendorLabel} / ID ${connection.storeConnectionId} / ${formatStatus(connection.status)}`,
        search: [
          connection.storeConnectionId,
          storeLabel,
          connection.shopDomain,
          connection.platform,
          connection.status,
          vendorLabel,
          connection.vendor.email,
          connection.vendor.vendorId,
        ].filter(Boolean).join(" "),
      };
    });

  return [
    vendorIdFilter === null
      ? {
        value: RETURN_POLICY_ANY_STORE_VALUE,
        label: "Global (no store)",
        detail: "Not scoped to a store connection",
        search: "global default no store any",
      }
      : {
        value: RETURN_POLICY_ANY_STORE_VALUE,
        label: "Any store (vendor scope)",
        detail: "Applies to every store connection for the selected vendor",
        search: "any store vendor scope all",
      },
    ...storeOptions,
  ];
}
