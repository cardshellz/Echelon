import {
  stockLinkCheckAgainRequestSchema,
  stockLinkContinueRequestSchema,
  stockLinkSwitchRequestSchema,
  type StockLinkCheckAgainRequest,
  type StockLinkContinueRequest,
  type StockLinkStatus,
  type StockLinkSupportedStatus,
  type StockLinkSwitchRequest,
} from "@shared/types/stock-link";

import type { DestinationIdentity } from "./model";

/**
 * Pure presentation of a destination's automatic stock linking (PLAN-CH2 v4.1 §9): which destinations ask for a
 * status, what the switch row and the details section show, and the control requests. The server decides support
 * (`supported`), counts and states; nothing here infers them.
 */

/** Every staff word of the stock-link controls. PLAN-CH2 v4.1 §9 marks each one PROPOSED. */
export const STOCK_LINK_WORDS = {
  /* PROPOSED: owner wording */
  switchLabel: "Link store items by SKU",
  /* PROPOSED: owner wording */
  status: (counts: StockLinkSupportedStatus["counts"]) =>
    `${counts.linked} linked · ${counts.waiting} waiting for a store item · ${counts.flagged} need a fix · ${counts.error} failed`,
  /* PROPOSED: owner wording */
  paused: "Linking is paused: the store stopped answering. It resumes by itself.",
  /* PROPOSED: owner wording (singular form for one item added in the build, D-P9-3) */
  held: (count: number) => count === 1
    ? "1 item lost its SKU today. Echelon kept its link. Check the store, then press Continue."
    : `${count} items lost their SKU today. Echelon kept their links. Check the store, then press Continue.`,
  /* PROPOSED: owner wording */
  halted: "Linking stopped because of a setup problem. Fix it, then press Check again.",
  /* PROPOSED: owner wording */
  continueButton: "Continue",
  /* PROPOSED: owner wording */
  checkAgainButton: "Check again",
  /* PROPOSED: owner wording */
  turnOffTitle: (store: string) => `Turn off linking for ${store}?`,
  /* PROPOSED: owner wording */
  turnOffBody: "Existing links keep sending stock. New sizes and replaced store items will not be linked until you turn it back on.",
  /* PROPOSED: owner wording (button text of the confirm, not in the plan's list, D-P9-3) */
  turnOffConfirm: "Turn off linking",
  /* PROPOSED: owner wording */
  turnedOn: (store: string) => `Linking turned on for ${store}`,
  /* PROPOSED: owner wording */
  turnedOff: (store: string) => `Linking turned off for ${store}`,
  /* PROPOSED: owner wording */
  checking: (store: string) => `Checking ${store} again`,
  /* PROPOSED: owner wording */
  noPermission: "Changing linking requires inventory activation permission.",
  /* PROPOSED: owner wording (a status read that failed with a server error, not in the plan's list, D-P9-2) */
  unavailable: "Linking status could not be loaded.",
  /* PROPOSED: owner wording (a refresh failed after a good answer, so the last answer is shown, not in the plan's list, review TST-1) */
  refreshFailed: "Linking status could not be refreshed. This shows the last answer.",
  /* PROPOSED: owner wording (retry button for the failed read, not in the plan's list, D-P9-2) */
  reloadStatus: "Reload linking status",
  /* PROPOSED: owner wording (details heading state, not in the plan's list, D-P9-3) */
  heading: (on: boolean) => `Link store items by SKU · ${on ? "On" : "Off"}`,
  /* PROPOSED: owner wording (the server's kill switch is on, not in the plan's list, review CMP-1) */
  runnerOff: "Automatic linking is turned off for every store on the server. Existing links keep sending stock; nothing is linked or changed until it is turned back on.",
  /* PROPOSED: owner wording (toasts of a refused control, keyed by the server's code, not in the plan's list, review TST-2) */
  controlRefused: {
    STOCK_LINK_DESTINATION_STALE: { title: "Linking changed on another screen", message: "The linking status was reloaded. Check it, then try again." },
    STOCK_LINK_DESTINATION_BUSY: { title: "Linking is busy", message: "Echelon is checking this store right now. Try again in a moment." },
    STOCK_LINK_DESTINATION_UNSUPPORTED: { title: "Linking is not available", message: "Automatic linking is not available for this store." },
  } as Readonly<Record<string, { title: string; message: string }>>,
} as const;

/**
 * The toast of a refused control (review TST-2): the stock-link codes in staff words, anything else as every other
 * Channel Inventory error is described.
 */
export function describeStockLinkControlError(error: unknown, describe: (error: unknown) => { title: string; message: string }):
  { title: string; message: string } {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code : null;
  const words = code === null ? undefined : STOCK_LINK_WORDS.controlRefused[code];
  return words ?? describe(error);
}

/**
 * Only a Shopify channel connection can have a stock-link policy today (server STOCK_LINK_CONTROLLED_DESTINATIONS,
 * D-P8-2), so no other destination sends the status read at all. The server's `supported` still decides.
 */
export function stockLinkStatusApplies(identity: Pick<DestinationIdentity, "kind" | "provider">): boolean {
  return identity.kind === "channel_connection" && identity.provider === "shopify";
}

export type StockLinkCallout = { tone: "warning" | "danger"; text: string };

export type StockLinkPresentation =
  | { kind: "hidden" }
  | { kind: "unavailable"; text: string }
  | {
    kind: "shown";
    switchOn: boolean;
    statusLine: string;
    callouts: readonly StockLinkCallout[];
    showContinue: boolean;
    showCheckAgain: boolean;
  };

/**
 * `status` is the parsed answer, or undefined while loading; `failed` is true when the read failed with an error the
 * fetch did not already turn into `supported: false` (a 404, a network error or an unparseable answer, §9 TST-14).
 * When a refresh fails after a supported answer, React Query keeps that answer: it stays shown, with a line saying it
 * is not current, so a short drop never hides the switch or strands an open confirm (review TST-1).
 */
export function describeStockLink(status: StockLinkStatus | undefined, failed: boolean): StockLinkPresentation {
  if (failed && !status?.supported) return { kind: "unavailable", text: STOCK_LINK_WORDS.unavailable };
  if (!status || !status.supported) return { kind: "hidden" };
  const callouts: StockLinkCallout[] = [];
  if (failed) callouts.push({ tone: "warning", text: STOCK_LINK_WORDS.refreshFailed });
  const runnerOff = status.runnerOff === true;
  // The server's kill switch first: while it is on nothing resumes by itself, so the paused line is not shown (CMP-1).
  if (runnerOff) callouts.push({ tone: "warning", text: STOCK_LINK_WORDS.runnerOff });
  if (status.halted) callouts.push({ tone: "danger", text: STOCK_LINK_WORDS.halted });
  if (status.retiresHeld) callouts.push({ tone: "warning", text: STOCK_LINK_WORDS.held(status.retiresHeld.count) });
  if (status.paused && !runnerOff) callouts.push({ tone: "warning", text: STOCK_LINK_WORDS.paused });
  return {
    kind: "shown",
    switchOn: status.autoLinkEnabled,
    statusLine: STOCK_LINK_WORDS.status(status.counts),
    callouts,
    // §9: "Continue" only when held or paused; "Check again" is always offered.
    showContinue: status.retiresHeld !== null || status.paused !== null,
    showCheckAgain: true,
  };
}

/** §9: turning off opens a confirm dialog; turning on calls the switch directly. */
export function stockLinkSwitchAction(checked: boolean): "confirm_off" | "turn_on" {
  return checked ? "turn_on" : "confirm_off";
}

// Request builders: every control carries the status's revision so a stale screen gets 409 STALE, never a blind write.

export function buildStockLinkSwitchRequest(status: StockLinkSupportedStatus, enabled: boolean): StockLinkSwitchRequest {
  return stockLinkSwitchRequestSchema.parse({
    publicationTargetId: status.publicationTargetId, enabled, expectedRevision: status.revision, reason: null,
  });
}

export function buildStockLinkContinueRequest(status: StockLinkSupportedStatus): StockLinkContinueRequest {
  return stockLinkContinueRequestSchema.parse({ publicationTargetId: status.publicationTargetId, expectedRevision: status.revision });
}

export function buildStockLinkCheckAgainRequest(status: StockLinkSupportedStatus): StockLinkCheckAgainRequest {
  return stockLinkCheckAgainRequestSchema.parse({ publicationTargetId: status.publicationTargetId, expectedRevision: status.revision });
}

/** 409 STALE means the screen is behind the destination row: reload the status before anyone retries. */
export const STOCK_LINK_RELOAD_CODES: ReadonlySet<string> = new Set(["STOCK_LINK_DESTINATION_STALE"]);
