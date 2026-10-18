import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  RewardWidgetState,
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
const commandSchema = z
  .object({
    requestKey: z.string().uuid(),
    points: z.number().int().positive().max(99_999_999),
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
  onBusy(busy: boolean): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<WidgetHandle | undefined>(undefined);
  const inFlight = useRef(false);
  const current = useRef({ onApply, onBusy, disabled });
  current.current = { onApply, onBusy, disabled };
  const [data, setData] = useState<RewardWidgetState | null>(null);
  const [ready, setReady] = useState(
    Boolean(window.CardShellz?.mountRedemptionWidget),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [points, setPoints] = useState(0);
  const storageKey = `cardshellz:editor-reward:${actorKey}`;
  const refresh = async (signal?: AbortSignal) => {
    const result = await api.rewards.state(connectionId, omsOrderId, signal);
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
  const maxPoints = Number(
    (BigInt(Math.max(0, maxDiscountCents)) * rateUnits) / BigInt(10_000),
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
      {data?.rewards
        .filter(
          (reward) =>
            !appliedCodes.some(
              (code) => code.toUpperCase() === reward.code.toUpperCase(),
            ),
        )
        .map((reward) => (
          <button
            key={reward.code}
            className="oe-reward-existing"
            type="button"
            disabled={disabled || busy}
            onClick={() => void run(() => current.current.onApply(reward.code))}
          >
            Use saved ${reward.value} reward <span>{reward.code}</span>
          </button>
        ))}
    </section>
  );
}
