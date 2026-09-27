import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreviewError, previewSelectClass } from "./CustomerReturnPreviewSteps";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import {
  loadReturnLabelSettings,
  returnLabelsEnabled,
  saveReturnLabelSettings,
} from "@/lib/customer-return-labels";
import {
  customerReturnLabelSettingsInputSchema,
  type CustomerReturnLabelSettingsInput,
  type CustomerReturnLabelSettingsState,
} from "@shared/returns/customer-return-label.contract";
import { ReturnLabelCarrierRules } from "./ReturnLabelCarrierRules";
import { DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS } from "@shared/returns/customer-return-portal-policy";
import {
  createReturnLabelSettingsDraft,
  refreshReturnLabelSettingsDraft,
  returnLabelSettingsReadiness,
  RETURN_LABEL_SETTINGS_PATH,
  type ReturnLabelSettingsDraft,
  type ReturnLabelSettingsField,
} from "@/lib/customer-return-label-settings";

const fieldIds: Record<ReturnLabelSettingsField, string> = {
  warehouseId: "return-label-warehouse",
  policyId: "return-label-policy",
  contactName: "return-label-contact",
  contactPhone: "return-label-phone",
  carrierId: "return-label-carrier",
  serviceCode: "return-label-service",
  carrierRules: "return-label-carrier-rules",
};

const emptyDraft: ReturnLabelSettingsDraft = {
  warehouseId: "",
  policyId: "",
  carrierId: "",
  serviceCode: "",
  selectionMode: "cheapest_eligible",
  carrierRules: [],
  contactName: "",
  contactPhone: "",
  enabled: false,
};

export function CustomerReturnLabelSettings({
  channelId,
  locked,
  accepted = false,
  compact = false,
  onState,
  onAccessDenied,
}: {
  channelId: number;
  locked: boolean;
  accepted?: boolean;
  compact?: boolean;
  onState: (state: CustomerReturnLabelSettingsState | null) => void;
  onAccessDenied: (message: string) => void;
}) {
  const [state, setState] = useState<CustomerReturnLabelSettingsState | null>(
    null,
  );
  const [draft, setDraft] = useState<ReturnLabelSettingsDraft>({
    ...emptyDraft,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  const loadedChannel = useRef<number | null>(null);
  const draftDirty = useRef(false);
  const draftVersion = useRef<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const sameChannel = loadedChannel.current === channelId;
    if (!sameChannel) {
      setDraft({ ...emptyDraft });
      draftDirty.current = false;
      draftVersion.current = null;
      setVersionConflict(false);
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    setState(null);
    onState(null);
    void loadReturnLabelSettings(channelId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setState(next);
        const keepDraft = sameChannel && draftDirty.current;
        const nextVersion = next.settings?.version ?? 0;
        const conflict = keepDraft && draftVersion.current !== nextVersion;
        setVersionConflict(conflict);
        if (!conflict) draftVersion.current = nextVersion;
        setDraft((current) =>
          keepDraft
            ? refreshReturnLabelSettingsDraft(current, next)
            : createReturnLabelSettingsDraft(next),
        );
        loadedChannel.current = channelId;
        onState(next);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "Label configuration is unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [channelId, attempt, onState, onAccessDenied]);

  const carrier = state?.carriers.find((item) => item.id === draft.carrierId);
  const readiness = state ? returnLabelSettingsReadiness(draft, state) : null;
  const parsed = readiness?.parsed;
  const canSave = (readiness?.canSave ?? false) && !versionConflict;
  function hasIssue(field: ReturnLabelSettingsField) {
    return readiness?.issues.some((issue) => issue.field === field) ?? false;
  }
  function description(field: ReturnLabelSettingsField, helperId?: string) {
    return (
      [helperId, hasIssue(field) ? `${fieldIds[field]}-error` : undefined]
        .filter(Boolean)
        .join(" ") || undefined
    );
  }
  function fieldErrors(field: ReturnLabelSettingsField) {
    const issues =
      readiness?.issues.filter((issue) => issue.field === field) ?? [];
    return issues.length > 0 ? (
      <div
        id={`${fieldIds[field]}-error`}
        className="space-y-1 text-xs text-destructive"
      >
        {issues.map((issue) => (
          <p key={issue.message}>{issue.message}</p>
        ))}
      </div>
    ) : null;
  }

  useEffect(
    () => () => {
      saveController.current?.abort();
    },
    [],
  );
  async function save() {
    if (!parsed?.success || !canSave || busy || locked) return;
    await persist(parsed.data);
  }
  async function setEnabled(enabled: boolean) {
    if (
      !state?.settings ||
      busy ||
      (locked && !accepted) ||
      (enabled && !state.providerConfigured)
    )
      return;
    const {
      version,
      destinationAddress: _address,
      ...settings
    } = state.settings;
    await persist(
      customerReturnLabelSettingsInputSchema.parse({
        ...settings,
        enabled,
        expectedVersion: version,
      }),
    );
  }
  async function persist(input: CustomerReturnLabelSettingsInput) {
    const controller = new AbortController();
    saveController.current = controller;
    setBusy(true);
    setError(null);
    setSaved(false);
    // A save may have succeeded after a transport failure; hide the create capability
    // until the current optimistic version has been read back.
    onState(null);
    try {
      const next = await saveReturnLabelSettings(
        channelId,
        input,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setState(next);
      setDraft(createReturnLabelSettingsDraft(next));
      draftDirty.current = false;
      draftVersion.current = next.settings?.version ?? 0;
      setVersionConflict(false);
      onState(next);
      setSaved(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
      else
        setError(
          "The configuration was not confirmed. Refresh label settings before saving again.",
        );
      setState(null);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function update(patch: Partial<ReturnLabelSettingsDraft>) {
    draftDirty.current = true;
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  }
  function resolveVersionConflict(keepChanges: boolean) {
    if (!state || busy || locked) return;
    if (!keepChanges) {
      setDraft(createReturnLabelSettingsDraft(state));
      draftDirty.current = false;
    }
    // An explicit acknowledgement is required before rebasing unsaved choices
    // onto another administrator's newer version. The server still enforces CAS.
    draftVersion.current = state.settings?.version ?? 0;
    setVersionConflict(false);
    setSaved(false);
  }
  return (
    <section
      aria-labelledby="return-label-settings-title"
      className="space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="return-label-settings-title" className="font-semibold">
          Return label settings
        </h2>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh label settings
        </Button>
      </div>
      <p className="text-xs">
        Saved settings apply to this Shopify shop. Enabling labels permits real
        return creation and shipping-label purchases for private testing.
        Refunds remain manual in Shopify.
      </p>
      {compact && (
        <Button variant="outline" asChild>
          <Link
            href={`${RETURN_LABEL_SETTINGS_PATH}?channelId=${channelId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage label settings
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
        </Button>
      )}
      <PreviewError message={error} />
      {busy && (
        <p role="status" className="text-sm">
          Loading or saving label settings…
        </p>
      )}
      {state && (
        <>
          <p className="text-sm" role="status">
            {returnLabelsEnabled(state)
              ? "Label creation is enabled for this shop."
              : (state.message ??
                (!state.providerConfigured
                  ? "The shipping provider is not configured. Label creation is unavailable."
                  : "Label creation is off until a complete configuration is saved and enabled."))}
          </p>
          {state.settings?.enabled && (
            <Button
              variant="outline"
              disabled={busy || (locked && !accepted)}
              onClick={() => void setEnabled(false)}
            >
              Pause labels
            </Button>
          )}
          {accepted && state.settings && !state.settings.enabled && (
            <Button
              variant="outline"
              disabled={busy || !state.providerConfigured}
              onClick={() => void setEnabled(true)}
            >
              Resume labels
            </Button>
          )}
          {!compact && (
            <fieldset
              disabled={busy || locked || !state.providerConfigured}
              className="space-y-3"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="inline-flex items-baseline gap-1">
                    <Label htmlFor="return-label-warehouse">
                      Return warehouse
                    </Label>
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted-foreground"
                    >
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
                    onChange={(event) =>
                      update({ warehouseId: event.target.value })
                    }
                  >
                    <option value="">Choose a warehouse</option>
                    {state.warehouses.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.address}
                      >
                        {item.name}
                        {!item.address ? " · address required" : ""}
                      </option>
                    ))}
                  </select>
                  {fieldErrors("warehouseId")}
                </div>
                <div className="space-y-1">
                  <div className="inline-flex items-baseline gap-1">
                    <Label htmlFor="return-label-policy">Return policy</Label>
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted-foreground"
                    >
                      (required)
                    </span>
                  </div>
                  <select
                    id="return-label-policy"
                    className={previewSelectClass}
                    value={draft.policyId}
                    aria-required="true"
                    aria-invalid={hasIssue("policyId")}
                    aria-describedby={description(
                      "policyId",
                      "return-label-policy-help",
                    )}
                    onChange={(event) =>
                      update({ policyId: event.target.value })
                    }
                  >
                    <option value="">Choose a policy</option>
                    {state.policies.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · version {item.version}
                      </option>
                    ))}
                  </select>
                  <p
                    id="return-label-policy-help"
                    className="text-xs text-muted-foreground"
                  >
                    Rules used to authorize and receive returns for this shop.
                    Labels require an active{" "}
                    {DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS}-day retail policy
                    handled by Card Shellz, with Card Shellz paying for
                    ShipStation return labels and no vendor settlement.
                  </p>
                  {fieldErrors("policyId")}
                  <a
                    href={
                      state.policies.length === 0
                        ? `/return-policies?portalChannelId=${channelId}`
                        : "/return-policies"
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-sm underline underline-offset-2"
                  >
                    {state.policies.length === 0
                      ? "Review return policy setup"
                      : "Manage return policies"}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <p className="text-xs text-muted-foreground">
                    {state.policies.length === 0
                      ? "Review and save the prefilled policy, then return here and refresh label settings."
                      : "After changing policies, return here and refresh label settings."}{" "}
                    Your unsaved label settings will stay in place.
                  </p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="return-label-selection-mode">
                    Service selection
                  </Label>
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
                        update({ selectionMode });
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
                        update({
                          carrierId: event.target.value,
                          serviceCode: "",
                        })
                      }
                    >
                      <option value="">Choose a carrier</option>
                      {state.carriers.map((item) => (
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
                        update({ serviceCode: event.target.value })
                      }
                    >
                      <option value="">Choose a return service</option>
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
                    <Label htmlFor="return-label-contact">
                      Return contact name
                    </Label>
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted-foreground"
                    >
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
                    onChange={(event) =>
                      update({ contactName: event.target.value })
                    }
                  />
                  <p
                    id="return-label-contact-help"
                    className="text-xs text-muted-foreground"
                  >
                    Name of the person or team receiving returns, printed on the
                    return shipping label.
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
                    onChange={(event) =>
                      update({ contactPhone: event.target.value })
                    }
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
                    carriers={state.carriers}
                    rules={draft.carrierRules}
                    onChange={(carrierRules) => update({ carrierRules })}
                  />
                  {fieldErrors("carrierRules")}
                </div>
              )}
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    update({ enabled: event.target.checked })
                  }
                  className="h-5 w-5"
                />
                Enable real return labels for this shop
              </label>
              {versionConflict && (
                <div
                  id="return-label-settings-conflict"
                  data-testid="return-label-settings-conflict"
                  role="alert"
                  className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                >
                  <p>
                    Saved label settings changed while you were editing. Your
                    unsaved choices are still here. Keeping your changes will
                    replace the current saved configuration.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => resolveVersionConflict(false)}
                    >
                      Use saved settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => resolveVersionConflict(true)}
                    >
                      Keep my changes
                    </Button>
                  </div>
                </div>
              )}
              {readiness && readiness.issues.length > 0 && (
                <div
                  id="return-label-settings-blockers"
                  data-testid="return-label-settings-blockers"
                  className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                >
                  <p className="font-medium">Complete before saving</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {readiness.issues.map((issue) => (
                      <li key={`${issue.field}:${issue.message}`}>
                        {issue.field ? (
                          <button
                            type="button"
                            className="text-left underline underline-offset-2"
                            onClick={() => {
                              if (issue.field)
                                document
                                  .getElementById(fieldIds[issue.field])
                                  ?.focus();
                            }}
                          >
                            {issue.message}
                          </button>
                        ) : (
                          issue.message
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Button
                disabled={!canSave}
                aria-describedby={
                  [
                    versionConflict
                      ? "return-label-settings-conflict"
                      : undefined,
                    readiness?.issues.length
                      ? "return-label-settings-blockers"
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onClick={() => void save()}
              >
                Save label settings
              </Button>
            </fieldset>
          )}
        </>
      )}
      {saved && (
        <p role="status" className="text-sm">
          Label settings saved.
        </p>
      )}
      {locked && (
        <p className="text-xs">
          {accepted
            ? "Return details stay fixed. You can refresh settings or pause and resume this saved configuration."
            : "Finish checking the current return before changing its configuration."}
        </p>
      )}
    </section>
  );
}
