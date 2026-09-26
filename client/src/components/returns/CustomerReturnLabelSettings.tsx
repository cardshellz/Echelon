import { useEffect, useRef, useState } from "react";
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

interface SettingsDraft {
  warehouseId: string;
  policyId: string;
  carrierId: string;
  serviceCode: string;
  contactName: string;
  contactPhone: string;
  enabled: boolean;
}
const emptyDraft: SettingsDraft = {
  warehouseId: "",
  policyId: "",
  carrierId: "",
  serviceCode: "",
  contactName: "",
  contactPhone: "",
  enabled: false,
};
function draftFor(state: CustomerReturnLabelSettingsState): SettingsDraft {
  const settings = state.settings;
  return settings
    ? {
        warehouseId: String(settings.warehouseId),
        policyId: String(settings.policyId),
        carrierId: settings.carrierId,
        serviceCode: settings.serviceCode,
        contactName: settings.contactName,
        contactPhone: settings.contactPhone ?? "",
        enabled: settings.enabled,
      }
    : { ...emptyDraft };
}

export function CustomerReturnLabelSettings({
  channelId,
  locked,
  accepted = false,
  onState,
  onAccessDenied,
}: {
  channelId: number;
  locked: boolean;
  accepted?: boolean;
  onState: (state: CustomerReturnLabelSettingsState | null) => void;
  onAccessDenied: (message: string) => void;
}) {
  const [state, setState] = useState<CustomerReturnLabelSettingsState | null>(
    null,
  );
  const [draft, setDraft] = useState<SettingsDraft>({ ...emptyDraft });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setSaved(false);
    setState(null);
    onState(null);
    void loadReturnLabelSettings(channelId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setState(next);
        setDraft(draftFor(next));
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
  const parsed = customerReturnLabelSettingsInputSchema.safeParse({
    expectedVersion: state?.settings?.version ?? 0,
    enabled: draft.enabled,
    warehouseId: Number(draft.warehouseId),
    policyId: Number(draft.policyId),
    carrierId: draft.carrierId,
    serviceCode: draft.serviceCode,
    contactName: draft.contactName,
    contactPhone: draft.contactPhone.trim() || null,
  });
  const canSave =
    parsed.success &&
    state?.providerConfigured &&
    state.warehouses.some(
      (item) => String(item.id) === draft.warehouseId && item.address !== null,
    ) &&
    state.policies.some((item) => String(item.id) === draft.policyId) &&
    carrier?.services.some((item) => item.code === draft.serviceCode);

  useEffect(
    () => () => {
      saveController.current?.abort();
    },
    [],
  );
  async function save() {
    if (!parsed.success || !canSave || busy || locked) return;
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
      setDraft(draftFor(next));
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
  function update(patch: Partial<SettingsDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
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
          <fieldset
            disabled={busy || locked || !state.providerConfigured}
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="return-label-warehouse">Return warehouse</Label>
                <select
                  id="return-label-warehouse"
                  className={previewSelectClass}
                  value={draft.warehouseId}
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
              </div>
              <div className="space-y-1">
                <Label htmlFor="return-label-policy">Return policy</Label>
                <select
                  id="return-label-policy"
                  className={previewSelectClass}
                  value={draft.policyId}
                  onChange={(event) => update({ policyId: event.target.value })}
                >
                  <option value="">Choose a policy</option>
                  {state.policies.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · version {item.version}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="return-label-carrier">Return carrier</Label>
                <select
                  id="return-label-carrier"
                  className={previewSelectClass}
                  value={draft.carrierId}
                  onChange={(event) =>
                    update({ carrierId: event.target.value, serviceCode: "" })
                  }
                >
                  <option value="">Choose a carrier</option>
                  {state.carriers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="return-label-service">Return service</Label>
                <select
                  id="return-label-service"
                  className={previewSelectClass}
                  value={draft.serviceCode}
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
              </div>
              <div className="space-y-1">
                <Label htmlFor="return-label-contact">
                  Return contact name
                </Label>
                <Input
                  id="return-label-contact"
                  maxLength={200}
                  value={draft.contactName}
                  onChange={(event) =>
                    update({ contactName: event.target.value })
                  }
                />
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
                  onChange={(event) =>
                    update({ contactPhone: event.target.value })
                  }
                />
              </div>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
                className="h-5 w-5"
              />
              Enable real return labels for this shop
            </label>
            <Button disabled={!canSave} onClick={() => void save()}>
              Save label settings
            </Button>
          </fieldset>
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
