import { STOCK_LINK_DECISION_CODES } from "./stock-link";

/**
 * What a person's stock-link control changes on one destination (channels PR2, PLAN-CH2 v4.1 §7.3): the per-store
 * switch, Continue and Check again. Pure: the repository passes the destination row as it locked it (FOR UPDATE) and
 * whether the retire hold is keeping any size's link (a held check row not due yet, as of the injected clock), and
 * writes exactly what the plan names, with its audit row, in the same transaction.
 *
 * - Switch: sets the switch; the same value again changes nothing (no write, no audit row).
 * - Continue: releases a held retire window (the window restarts now, so the 25 retires are allowed again), makes the
 *   held sizes due now so the next tick decides them instead of in 24 h (review LNK-1), and makes a
 *   paused destination try again on the next tick (the pause's code and start stay: a store that still refuses is
 *   paused again and its "paused for over an hour" clock keeps running). Neither held nor paused: nothing changes.
 * - Check again: every `error`, `flagged` and `linked` row, plus Shopify status-ineligible waiting rows, is due now
 *   with its attempts and streaks reset, and a halt is cleared. Always written: it is a person's request to look
 *   again, recorded even when no row was due.
 */

export const STOCK_LINK_CONTROL_KINDS = ["switch", "continue", "check_again"] as const;
export type StockLinkControlKind = (typeof STOCK_LINK_CONTROL_KINDS)[number];

/** public.audit_events.action of each control (§7.3). */
export const STOCK_LINK_CONTROL_AUDIT_ACTIONS: Readonly<Record<StockLinkControlKind, string>> = Object.freeze({
  switch: "inventory_availability.stock_link.switch_changed",
  continue: "inventory_availability.stock_link.continued",
  check_again: "inventory_availability.stock_link.check_requested",
});

/** Check-row statuses always made due. Other waiting rows keep their normal retry schedule. */
export const STOCK_LINK_CHECK_AGAIN_STATUSES = Object.freeze(["error", "flagged", "linked"] as const);

const SHOPIFY_WAITING_RECHECK_REASONS = Object.freeze([STOCK_LINK_DECISION_CODES.notOnSale]);
const NO_WAITING_RECHECK_REASONS: readonly string[] = Object.freeze([]);

/** A draft rejected by the former ACTIVE-only policy must be recheckable without
 * waiting for its historical backoff. This does not change other providers' eligibility. */
export function stockLinkCheckAgainWaitingReasons(destination: {
  readonly destinationKind: string;
  readonly providerKey: string | null;
}): readonly string[] {
  return destination.destinationKind === "channel_connection" && destination.providerKey === "shopify"
    ? SHOPIFY_WAITING_RECHECK_REASONS : NO_WAITING_RECHECK_REASONS;
}

export interface StockLinkControlDestinationState {
  readonly autoLinkEnabled: boolean;
  readonly pausedUntil: Date | null;
  readonly haltedAt: Date | null;
  /** Some size's retire is held right now (stockLinkRetiresHeldCountText > 0 as of the control's clock). */
  readonly retiresHeld: boolean;
}

export type StockLinkControlRequest =
  | { readonly kind: "switch"; readonly enabled: boolean }
  | { readonly kind: "continue" }
  | { readonly kind: "check_again" };

export interface StockLinkControlPlan {
  /** False: nothing is written (no revision bump, no audit row). */
  readonly changed: boolean;
  /** The switch after the control (unchanged unless the control is the switch). */
  readonly autoLinkEnabled: boolean;
  /** retires_released_at/by := now/actor, and the held sizes' check rows due now (same transaction). */
  readonly releaseRetires: boolean;
  /** paused_until := now (code and start kept). */
  readonly resumePause: boolean;
  /** halted_at/code := NULL. */
  readonly clearHalt: boolean;
  /** Standard statuses and provider-specific waiting reasons due now, attempts and streaks reset. */
  readonly makeRowsDue: boolean;
}

export function planStockLinkControl(request: StockLinkControlRequest, state: StockLinkControlDestinationState,
  now: Date): StockLinkControlPlan {
  const none = { changed: false, autoLinkEnabled: state.autoLinkEnabled, releaseRetires: false, resumePause: false,
    clearHalt: false, makeRowsDue: false };
  switch (request.kind) {
    case "switch":
      return request.enabled === state.autoLinkEnabled ? none : { ...none, changed: true, autoLinkEnabled: request.enabled };
    case "continue": {
      const releaseRetires = state.retiresHeld;
      // A pause that has already run out is retried by the next tick anyway; only a pause still in force moves.
      const resumePause = state.pausedUntil !== null && state.pausedUntil.getTime() > now.getTime();
      return releaseRetires || resumePause ? { ...none, changed: true, releaseRetires, resumePause } : none;
    }
    case "check_again":
      return { ...none, changed: true, clearHalt: state.haltedAt !== null, makeRowsDue: true };
  }
}
