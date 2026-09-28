import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PreviewError } from "./CustomerReturnPreviewSteps";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import {
  loadReturnLabelSettings,
  returnLabelsEnabled,
  saveReturnLabelControl,
} from "@/lib/customer-return-labels";
import type { CustomerReturnLabelSettingsState } from "@shared/returns/customer-return-label.contract";
import { returnPolicyEditorPath } from "@/lib/return-policy-shipping";

const policyScopeLabels = {
  global: "All orders",
  business_context: "Business context",
  channel_context: "Sales channel",
  vendor_context: "Dropship vendor",
  vendor_channel_context: "Dropship vendor and channel",
  store: "Dropship store",
} as const;

/** Portal status and purchase pause only. Policy versions own shipping configuration. */
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [returnRefresh, setReturnRefresh] = useState(0);
  const saveController = useRef<AbortController | null>(null);
  const loadedChannel = useRef<number | null>(null);
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
    setBusy(true);
    setAttempt((value) => value + 1);
  }, [returnRefresh, busy, locked]);

  useEffect(() => {
    const controller = new AbortController();
    operationInProgress.current = true;
    setBusy(true);
    setError(null);
    if (loadedChannel.current !== channelId) setState(null);
    onState(null);
    void loadReturnLabelSettings(channelId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setState(next);
        loadedChannel.current = channelId;
        onState(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState(null);
        if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "Return shipping is unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          operationInProgress.current = false;
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, [channelId, attempt, onState, onAccessDenied]);

  useEffect(
    () => () => {
      saveController.current?.abort();
    },
    [],
  );

  async function setPaused(paused: boolean) {
    if (
      !state ||
      busy ||
      operationInProgress.current ||
      (locked && !accepted) ||
      (!paused && !state.providerConfigured)
    )
      return;
    const controller = new AbortController();
    saveController.current = controller;
    operationInProgress.current = true;
    setBusy(true);
    setError(null);
    onState(null);
    try {
      const next = await saveReturnLabelControl(
        channelId,
        {
          paused,
          expectedVersion: state.control.version,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setState(next);
      onState(next);
    } catch (cause: unknown) {
      if (controller.signal.aborted) return;
      setState(null);
      if (cause instanceof PreviewAccessError) onAccessDenied(cause.message);
      else
        setError(
          "The pause setting was not confirmed. Refresh label settings before trying again.",
        );
    } finally {
      if (!controller.signal.aborted) {
        operationInProgress.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section
      aria-labelledby="return-label-settings-title"
      className="space-y-3 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="return-label-settings-title" className="font-semibold">
          Return shipping
        </h2>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (operationInProgress.current) return;
            operationInProgress.current = true;
            setBusy(true);
            setAttempt((value) => value + 1);
          }}
        >
          Refresh label settings
        </Button>
      </div>
      <p className="text-xs">
        The applied return policy supplies the warehouse, carriers and return
        rules. Refunds remain manual in Shopify.
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
            {state.control.paused
              ? "Label purchases are paused for this shop, including saved returns."
              : returnLabelsEnabled(state)
                ? "Label creation is enabled for this shop."
                : (state.message ??
                  (!state.providerConfigured
                    ? "The shipping provider is not configured. Label creation is unavailable."
                    : state.settings?.enabled &&
                        (state.policyIssue || !state.resolvedPolicy)
                      ? "New returns are blocked by the policy shown below."
                      : "Label creation is off until return shipping is configured and enabled in the applied policy."))}
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
              <p className="text-destructive" role="status">
                {state.policyIssue?.message ??
                  "No active return policy applies to this shop."}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The most specific active policy applies automatically. Policy
              settings refresh when you return to this tab.
            </p>
            <a
              href={
                state.resolvedPolicy
                  ? returnPolicyEditorPath(state.resolvedPolicy.id)
                  : "/return-policies"
              }
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block underline underline-offset-2"
            >
              {state.resolvedPolicy
                ? "Edit return policy"
                : "Manage return policies"}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </section>
          {(state.settings || accepted) && (
            <Button
              variant="outline"
              disabled={
                busy ||
                (locked && !accepted) ||
                (state.control.paused && !state.providerConfigured)
              }
              onClick={() => void setPaused(!state.control.paused)}
            >
              {state.control.paused ? "Resume labels" : "Pause labels"}
            </Button>
          )}
        </>
      )}
      {locked && (
        <p className="text-xs">
          {accepted
            ? "Saved return details stay fixed. You can refresh settings or pause and resume label purchases."
            : "Finish checking the current return before changing its configuration."}
        </p>
      )}
    </section>
  );
}
