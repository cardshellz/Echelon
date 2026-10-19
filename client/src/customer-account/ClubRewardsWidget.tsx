import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  RewardWidgetManagementState,
  RewardWidgetIssueResult,
} from "@shared/customer-account/reward-widget";
import {
  CustomerAccountRequestError,
  type CustomerAccountTransport,
} from "./customer-account.transport";

type WidgetModel = {
  pointsBalance: string;
  pointsToRedeem: number;
  minRedemptionPoints: number;
  maxPoints: number;
  pointsPerDollar: string;
  currencyName: string;
  disabled: boolean;
  isLoading: boolean;
  error: string | null;
};
type WidgetHandle = {
  update(model: Partial<WidgetModel>): void;
  destroy(): void;
};
type WidgetHost = {
  mountRedemptionWidget(
    container: HTMLElement,
    model: WidgetModel,
    actions: {
      onChange(points: number): void;
      onApply(points: number): Promise<void>;
      onError(error: Error): void;
    },
  ): WidgetHandle;
};
declare global {
  interface Window {
    CardShellz?: WidgetHost;
  }
}
const MAX_POINTS_PER_REDEMPTION = 99_999_999;
const commandSchema = z
  .object({
    requestKey: z.string().uuid(),
    points: z.number().int().positive().max(MAX_POINTS_PER_REDEMPTION),
  })
  .strict();
const issueMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Your reward could not be confirmed. Please try again.";

/** React owns account authorization and order state. The existing Club script
 * owns the actual rewards controls, markup and styles used in the cart. */
export function ClubRewardsWidget({
  api,
  connectionId,
  omsOrderId,
  actorKey,
  disabled,
  maxDiscountCents,
  appliedCodes,
  onApply,
  onRemove,
  onBusy,
}: {
  api: CustomerAccountTransport;
  connectionId: number;
  omsOrderId: number;
  actorKey: string;
  disabled: boolean;
  maxDiscountCents: number;
  appliedCodes: string[];
  onApply(code: string): Promise<void>;
  onRemove(code: string): void;
  onBusy(busy: boolean): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<WidgetHandle | undefined>(undefined);
  const inFlight = useRef(false);
  const current = useRef({ onApply, onRemove, onBusy, disabled });
  current.current = { onApply, onRemove, onBusy, disabled };
  const [data, setData] = useState<RewardWidgetManagementState | null>(null);
  const [ready, setReady] = useState(
    Boolean(window.CardShellz?.mountRedemptionWidget),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [points, setPoints] = useState(0);
  const storageKey = `cardshellz:editor-reward:${actorKey}`;
  const refresh = async (signal?: AbortSignal) => {
    const result = await api.rewards.manage(connectionId, omsOrderId, signal);
    if (!signal?.aborted) setData(result);
    return result;
  };
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch((cause) => {
      if (!abort.signal.aborted) setError(issueMessage(cause));
    });
    return () => abort.abort();
  }, [api, connectionId, omsOrderId]);
  useEffect(() => {
    const loaded = () => {
      setReady(Boolean(window.CardShellz?.mountRedemptionWidget));
      setError(null);
    };
    window.addEventListener("cardshellz:rewards-ready", loaded);
    const timer = window.setTimeout(() => {
      if (!window.CardShellz?.mountRedemptionWidget)
        setError("Rewards couldn't load. Refresh this page to try again.");
    }, 12_000);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("cardshellz:rewards-ready", loaded);
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (inFlight.current || current.current.disabled) return;
    inFlight.current = true;
    setBusy(true);
    current.current.onBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(issueMessage(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
      current.current.onBusy(false);
    }
  }
  async function returnToPoints(rewardId: string) {
    await run(async () => {
      let returned;
      try {
        returned = await api.rewards.cancel(connectionId, omsOrderId, {
          rewardId,
          requestKey: crypto.randomUUID(),
        });
      } finally {
        // Cancellation is keyed by the reward in Club. An uncertain response
        // may already have returned the points; always reread its durable state.
        try {
          await refresh();
        } catch (cause) {
          setData(null);
          throw new Error(
            `Your latest rewards balance could not be loaded. ${issueMessage(cause)}`,
          );
        }
      }
      setNotice(
        `${returned.points.replace(/\.00$/, "")} points returned to your account.`,
      );
    });
  }
  async function issue(
    selectedPoints: number,
    retry?: z.infer<typeof commandSchema>,
  ) {
    await run(async () => {
      const saved = sessionStorage.getItem(storageKey);
      const command = commandSchema.parse(
        retry ??
          (saved
            ? JSON.parse(saved)
            : { requestKey: crypto.randomUUID(), points: selectedPoints }),
      );
      // Persist before the request. On any uncertain reply, retry this identity;
      // the server also exposes pending issuance after browser storage is lost.
      sessionStorage.setItem(storageKey, JSON.stringify(command));
      let reward: RewardWidgetIssueResult;
      try {
        reward = await api.rewards.issue(connectionId, omsOrderId, command);
      } catch (cause) {
        // These failures prove no new issuance was made. Unknown outcomes keep
        // their request key so retry cannot spend points a second time.
        if (
          cause instanceof CustomerAccountRequestError &&
          [
            "REWARD_REQUEST_INVALID",
            "REWARD_MINIMUM",
            "REWARD_BALANCE_INSUFFICIENT",
            "REWARD_REQUEST_FINISHED",
          ].includes(cause.code ?? "")
        )
          sessionStorage.removeItem(storageKey);
        // An error can arrive after Club reserved points. Read the canonical
        // balance and pending request before showing controls again; never keep
        // displaying the pre-request balance as spendable after an unknown reply.
        try {
          await refresh();
        } catch (refreshCause) {
          setData(null);
          throw new Error(
            `${issueMessage(cause)} Your latest rewards balance could not be loaded: ${issueMessage(refreshCause)}`,
          );
        }
        throw cause;
      }
      sessionStorage.removeItem(storageKey);
      await refresh();
      setPoints(0);
      try {
        await current.current.onApply(reward.code);
      } catch (cause) {
        throw new Error(
          `Your $${reward.value} reward is saved and can still be used. ${issueMessage(cause)}`,
        );
      }
    });
  }
  // Display-only cap; the server verifies full credit and native combination
  // rules again before any reservation or edit can be submitted.
  const rate = data?.pointsPerDollar.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  const rateUnits = rate
    ? BigInt(rate[1]) * BigInt(100) + BigInt((rate[2] ?? "").padEnd(2, "0"))
    : BigInt(0);
  const merchandiseCap =
    (BigInt(Math.max(0, maxDiscountCents)) * rateUnits) / BigInt(10_000);
  const maxPoints = Number(
    merchandiseCap < BigInt(MAX_POINTS_PER_REDEMPTION)
      ? merchandiseCap
      : BigInt(MAX_POINTS_PER_REDEMPTION),
  );
  const model: WidgetModel | null = data
    ? {
        pointsBalance: data.balance,
        pointsToRedeem: points,
        minRedemptionPoints: data.minimumPoints,
        maxPoints,
        pointsPerDollar: data.pointsPerDollar,
        currencyName: data.currencyName,
        disabled,
        isLoading: busy,
        error,
      }
    : null;
  useEffect(() => {
    if (
      !ready ||
      !container.current ||
      !model ||
      !window.CardShellz?.mountRedemptionWidget
    )
      return;
    handle.current = window.CardShellz.mountRedemptionWidget(
      container.current,
      model,
      {
        onChange: setPoints,
        onApply: issue,
        onError: (cause) => setError(issueMessage(cause)),
      },
    );
    return () => {
      handle.current?.destroy();
      handle.current = undefined;
    };
  }, [ready, Boolean(data), api, connectionId, omsOrderId, actorKey]);
  useEffect(() => {
    if (model) handle.current?.update(model);
  }, [data, points, maxPoints, disabled, busy, error]);
  return (
    <section className="oe-rewards" aria-label="Club rewards">
      <div ref={container} />
      {notice && (
        <p className="oe-reward-notice" role="status">
          {notice}
        </p>
      )}
      {!data && !error && <p role="status">Loading your rewards…</p>}
      {error && (!data || !ready) && <p role="alert">{error}</p>}
      {!data && error && (
        <button
          className="oe-reward-existing"
          type="button"
          disabled={disabled || busy}
          onClick={() =>
            void run(async () => {
              await refresh();
            })
          }
        >
          Retry loading rewards
        </button>
      )}
      {data?.pending.map((pending) => (
        <button
          key={pending.requestKey}
          className="oe-reward-existing"
          type="button"
          disabled={disabled || busy}
          onClick={() => void issue(pending.points, pending)}
        >
          Retry saved {pending.points.toLocaleString()} point reward
        </button>
      ))}
      {data?.rewards.map((reward) => {
        const selected = appliedCodes.some(
          (code) => code.toUpperCase() === reward.code.toUpperCase(),
        );
        const [whole, fraction = ""] = reward.value.split(".");
        const valueCents =
          BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
        const fits = valueCents <= BigInt(maxDiscountCents);
        const cancelling = reward.status === "cancelling";
        return (
          <div
            key={reward.id}
            className="oe-saved-reward"
            role="group"
            aria-label={`$${reward.value} saved reward`}
          >
            <div className="oe-saved-reward-heading">
              <strong>${reward.value} reward</strong>
              <span
                className={`oe-reward-status${selected ? " is-selected" : ""}`}
              >
                {selected
                  ? "Applied"
                  : cancelling
                    ? "Return pending"
                    : "Unused"}
              </span>
            </div>
            <div className="oe-saved-reward-actions">
              {selected ? (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => current.current.onRemove(reward.code)}
                >
                  Remove
                </button>
              ) : (
                <>
                  {!cancelling && (
                    <button
                      type="button"
                      className="oe-reward-use"
                      disabled={disabled || busy || !fits}
                      onClick={() =>
                        void run(() => current.current.onApply(reward.code))
                      }
                    >
                      Use reward
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => void returnToPoints(reward.id)}
                  >
                    {cancelling ? "Retry return to points" : "Return to points"}
                  </button>
                </>
              )}
            </div>
            {!selected && !cancelling && !fits && (
              <p className="oe-reward-value-note">
                This reward is larger than the remaining items total.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
