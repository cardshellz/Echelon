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
  contactName: "return-label-contact",
  contactPhone: "return-label-phone",
  carrierId: "return-label-carrier",
  serviceCode: "return-label-service",
  carrierRules: "return-label-carrier-rules",
};

const policyScopeLabels = {
  global: "All orders",
  business_context: "Business context",
  channel_context: "Sales channel",
  vendor_context: "Dropship vendor",
  vendor_channel_context: "Dropship vendor and channel",
  store: "Dropship store",
} as const;

const emptyDraft: ReturnLabelSettingsDraft = {
  warehouseId: "",
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
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [returnRefresh, setReturnRefresh] = useState(0);
  const [saved, setSaved] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  const loadedChannel = useRef<number | null>(null);
  const draftDirty = useRef(false);
  const draftVersion = useRef<number | null>(null);
  const operationInProgress = useRef(false);
  const handledReturnRefresh = useRef(0);

  useEffect(() => {
    let away = document.visibilityState !== "visible" || !document.hasFocus();
    function returned() {
      if (!away || document.visibilityState !== "visible") return;
      away = false;
      setReturnRefresh((value) => value + 1);
    }
    function left() {
      away = true;
    }
    function visibilityChanged() {
      if (document.visibilityState === "visible") returned();
      else left();
    }
    // One return can emit both visibility and focus. Treat them as one refresh,
    // and retain it while a configuration write or return operation is active.
    window.addEventListener("blur", left);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("blur", left);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  useEffect(() => {
    if (
      returnRefresh === handledReturnRefresh.current ||
      busy ||
      locked ||
      operationInProgress.current ||
      document.visibilityState !== "visible"
    )
      return;
    handledReturnRefresh.current = returnRefresh;
    operationInProgress.current = true;
    setBackgroundRefreshing(true);
    setBusy(true);
    setAttempt((value) => value + 1);
  }, [returnRefresh, busy, locked]);

  useEffect(() => {
    const controller = new AbortController();
    operationInProgress.current = true;
    const sameChannel = loadedChannel.current === channelId;
    if (!sameChannel) {
      setBackgroundRefreshing(false);
      setDraft({ ...emptyDraft });
      draftDirty.current = false;
      draftVersion.current = null;
      setVersionConflict(false);
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    if (!sameChannel) setState(null);
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
        setState(null);
        if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "Label configuration is unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          operationInProgress.current = false;
          setBackgroundRefreshing(false);
          setBusy(false);
        }
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
    if (
      !parsed?.success ||
      !canSave ||
      busy ||
      locked ||
      operationInProgress.current
    )
      return;
    await persist(parsed.data);
  }
  async function setEnabled(enabled: boolean) {
    if (
      !state?.settings ||
      busy ||
      operationInProgress.current ||
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
    operationInProgress.current = true;
    setBackgroundRefreshing(false);
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
      if (!controller.signal.aborted) {
        operationInProgress.current = false;
        setBusy(false);
      }
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
          onClick={() => {
            if (operationInProgress.current) return;
            operationInProgress.current = true;
            setBackgroundRefreshing(false);
            setBusy(true);
            setAttempt((value) => value + 1);
          }}
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
                  : state.settings?.enabled &&
                      (state.policyIssue || !state.resolvedPolicy)
                    ? "Shipping settings are enabled. New returns are blocked by the policy shown below."
                    : "Label creation is off until a complete configuration is saved and enabled."))}
          </p>
          <section
            aria-labelledby="return-applied-policy-title"
            data-testid="return-applied-policy"
            className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm"
          >
            <h3 id="return-applied-policy-title" className="font-medium">
              Applied return policy
            </h3>
            {state.resolvedPolicy && (
              <div>
                <p className="font-medium">
                  {state.resolvedPolicy.name} · version{" "}
                  {state.resolvedPolicy.version}
                </p>
                <p className="text-muted-foreground">
                  {policyScopeLabels[state.resolvedPolicy.scopeKind]} ·{" "}
                  {state.resolvedPolicy.returnWindowDays}-day return window from
                  purchase
                </p>
              </div>
            )}
            {(state.policyIssue || !state.resolvedPolicy) && (
              <div className="space-y-1" role="status">
                <p className="text-destructive">
                  {state.policyIssue?.message ??
                    "No active return policy applies to this shop."}
                </p>
                <p>
                  You can save shipping settings. New returns remain blocked
                  until an applicable policy is supported by this portal.
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The most specific active policy applies automatically. Manage the
              return window and return rules in Policies.
            </p>
            <a
              href="/return-policies"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block underline underline-offset-2"
            >
              Manage return policies
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <p className="text-xs text-muted-foreground">
              Policy settings refresh when you return to this tab. You can also
              refresh them above. Your unsaved shipping choices stay in place.
            </p>
          </section>
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
              disabled={
                (busy && !backgroundRefreshing) ||
                locked ||
                !state.providerConfigured
              }
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
                      disabled={busy}
                      onClick={() => resolveVersionConflict(false)}
                    >
                      Use saved settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
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
                disabled={busy || !canSave}
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
