import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_RETURN_WAREHOUSE_ADDRESS_TYPE, type CustomerReturnLabelSettingsState } from "@shared/returns/customer-return-label.contract";
import type {
  ReturnLabelSettingsDraft,
  ReturnLabelSettingsField,
  ReturnLabelSettingsIssue,
} from "@/lib/customer-return-label-settings";
import { previewSelectClass } from "./CustomerReturnPreviewSteps";
import { ReturnLabelCarrierRules } from "./ReturnLabelCarrierRules";
import { ReturnShippingGuardrailsFields } from "./ReturnShippingGuardrailsFields";

export const returnShippingFieldIds: Record<ReturnLabelSettingsField, string> =
  {
    warehouseId: "return-label-warehouse",
    warehouseAddressType: "return-label-warehouse-address-type",
    contactName: "return-label-contact",
    contactPhone: "return-label-phone",
    carrierId: "return-label-carrier",
    serviceCode: "return-label-service",
    carrierRules: "return-label-carrier-rules",
    parcelGuardrails: "return-label-parcel-guardrails",
  };

/** Controlled fields only. The containing editor owns loading, conflicts and save. */
export function ReturnPolicyShippingFields({
  draft,
  catalog,
  issues,
  onChange,
}: {
  draft: ReturnLabelSettingsDraft;
  catalog: Pick<CustomerReturnLabelSettingsState, "warehouses" | "carriers">;
  issues: readonly ReturnLabelSettingsIssue[];
  onChange: (patch: Partial<ReturnLabelSettingsDraft>) => void;
}) {
  const carrier = catalog.carriers.find((item) => item.id === draft.carrierId);
  const fieldIds = returnShippingFieldIds;
  function hasIssue(field: ReturnLabelSettingsField) {
    return issues.some((issue) => issue.field === field);
  }
  function description(field: ReturnLabelSettingsField, helperId?: string) {
    return (
      [helperId, hasIssue(field) ? `${fieldIds[field]}-error` : undefined]
        .filter(Boolean)
        .join(" ") || undefined
    );
  }
  function fieldErrors(field: ReturnLabelSettingsField) {
    const matching = issues.filter((issue) => issue.field === field);
    return matching.length > 0 ? (
      <div
        id={`${fieldIds[field]}-error`}
        className="space-y-1 text-xs text-destructive"
      >
        {matching.map((issue) => (
          <p key={issue.message}>{issue.message}</p>
        ))}
      </div>
    ) : null;
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="inline-flex items-baseline gap-1">
            <Label htmlFor="return-label-warehouse">Return warehouse</Label>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              (required)
            </span>
          </div>
          <select
            id="return-label-warehouse"
            className={previewSelectClass}
            value={draft.warehouseId}
            aria-required="true"
            aria-invalid={hasIssue("warehouseId")}
            aria-describedby={description("warehouseId")}
            onChange={(event) => onChange({ warehouseId: event.target.value })}
          >
            <option value="">Choose a warehouse</option>
            {catalog.warehouses.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.address}>
                {item.name}
                {!item.address ? " · address required" : ""}
              </option>
            ))}
          </select>
          {fieldErrors("warehouseId")}
        </div>
        <div className="space-y-1">
          <Label htmlFor={fieldIds.warehouseAddressType}>Warehouse address type</Label>
          <select
            id={fieldIds.warehouseAddressType}
            className={previewSelectClass}
            value={draft.warehouseAddressType ?? DEFAULT_RETURN_WAREHOUSE_ADDRESS_TYPE}
            aria-invalid={hasIssue("warehouseAddressType")}
            aria-describedby={description("warehouseAddressType", "return-label-warehouse-address-type-help")}
            onChange={(event) => {
              const warehouseAddressType = event.target.value;
              if (warehouseAddressType === "commercial" || warehouseAddressType === "residential")
                onChange({ warehouseAddressType });
            }}
          >
            <option value="commercial">Commercial</option>
            <option value="residential">Residential</option>
          </select>
          <p id="return-label-warehouse-address-type-help" className="text-xs text-muted-foreground">
            Used for carrier rates and labels at the return destination.
          </p>
          {fieldErrors("warehouseAddressType")}
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="return-label-selection-mode">Service selection</Label>
          <select
            id="return-label-selection-mode"
            className={previewSelectClass}
            value={draft.selectionMode}
            onChange={(event) => {
              const selectionMode = event.target.value;
              if (
                selectionMode === "fixed_service" ||
                selectionMode === "cheapest_eligible"
              )
                onChange({ selectionMode });
            }}
          >
            <option value="cheapest_eligible">
              Lowest eligible price for each box
            </option>
            <option value="fixed_service">
              One fixed service for all boxes
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            {draft.selectionMode === "cheapest_eligible"
              ? "Compare live return rates separately for each box. Different boxes may use different carriers."
              : "Every box uses the single connected carrier and service selected below."}
          </p>
        </div>
        {draft.selectionMode === "fixed_service" && (
          <div className="space-y-1">
            <Label htmlFor="return-label-carrier">Return carrier</Label>
            <select
              id="return-label-carrier"
              className={previewSelectClass}
              value={draft.carrierId}
              aria-required="true"
              aria-invalid={hasIssue("carrierId")}
              aria-describedby={description("carrierId")}
              onChange={(event) =>
                onChange({
                  carrierId: event.target.value,
                  serviceCode: "",
                })
              }
            >
              <option value="">Choose a carrier</option>
              {draft.carrierId && !carrier && (
                <option value={draft.carrierId}>
                  {draft.carrierId} · unavailable
                </option>
              )}
              {catalog.carriers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {fieldErrors("carrierId")}
          </div>
        )}
        {draft.selectionMode === "fixed_service" && (
          <div className="space-y-1">
            <Label htmlFor="return-label-service">Return service</Label>
            <select
              id="return-label-service"
              className={previewSelectClass}
              value={draft.serviceCode}
              aria-required="true"
              aria-invalid={hasIssue("serviceCode")}
              aria-describedby={description("serviceCode")}
              onChange={(event) =>
                onChange({ serviceCode: event.target.value })
              }
            >
              <option value="">Choose a return service</option>
              {draft.serviceCode &&
                !carrier?.services.some(
                  (item) => item.code === draft.serviceCode,
                ) && (
                  <option value={draft.serviceCode}>
                    {draft.serviceCode} · unavailable
                  </option>
                )}
              {carrier?.services.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
            {fieldErrors("serviceCode")}
          </div>
        )}
        <div className="space-y-1">
          <div className="inline-flex items-baseline gap-1">
            <Label htmlFor="return-label-contact">Return contact name</Label>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              (required)
            </span>
          </div>
          <Input
            id="return-label-contact"
            maxLength={200}
            value={draft.contactName}
            aria-required="true"
            aria-invalid={hasIssue("contactName")}
            aria-describedby={description(
              "contactName",
              "return-label-contact-help",
            )}
            onChange={(event) => onChange({ contactName: event.target.value })}
          />
          <p
            id="return-label-contact-help"
            className="text-xs text-muted-foreground"
          >
            Name of the person or team receiving returns, printed on the return
            shipping label.
          </p>
          {fieldErrors("contactName")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="return-label-phone">
            Return contact phone (optional)
          </Label>
          <Input
            id="return-label-phone"
            type="tel"
            maxLength={50}
            value={draft.contactPhone}
            aria-invalid={hasIssue("contactPhone")}
            aria-describedby={description("contactPhone")}
            onChange={(event) => onChange({ contactPhone: event.target.value })}
          />
          {fieldErrors("contactPhone")}
        </div>
      </div>
      {draft.selectionMode === "cheapest_eligible" && (
        <div
          id={fieldIds.carrierRules}
          tabIndex={-1}
          className="space-y-2"
          aria-describedby={description("carrierRules")}
        >
          <ReturnLabelCarrierRules
            carriers={catalog.carriers}
            rules={draft.carrierRules}
            requireAvailable={draft.enabled}
            onChange={(carrierRules) => onChange({ carrierRules })}
          />
          {fieldErrors("carrierRules")}
        </div>
      )}
      {draft.parcelGuardrails && <div id={fieldIds.parcelGuardrails} tabIndex={-1} className="space-y-2"
        aria-describedby={description("parcelGuardrails")}>
        <ReturnShippingGuardrailsFields draft={draft.parcelGuardrails} onChange={parcelGuardrails => onChange({ parcelGuardrails })} />
        {fieldErrors("parcelGuardrails")}
      </div>}
    </>
  );
}
