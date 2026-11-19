import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  STOCK_LINK_CONTROL_AUDIT_ACTIONS, planStockLinkControl, stockLinkCheckAgainWaitingReasons, type StockLinkControlDestinationState,
} from "../../domain/stock-link-controls";
import { stockLinkRunnerDisableReason } from "../../infrastructure/stock-link-runner-switch";
import {
  StockLinkControlsService, type StockLinkControlCommand, type StockLinkControlOutcome, type StockLinkControlsStore,
} from "../../application/stock-link-controls.service";
import { createWalmartStockLinkAdapter } from "../../../channels/adapters/walmart/walmart-stock-link.adapter";
import { createWalmartStockLinkSource } from "../../../channels/infrastructure/walmart-stock-link-source";
import { createChannelEbayStockLinkAdapter } from "../../../channels/adapters/ebay/ebay-stock-link.adapter";
import { createChannelEbayStockLinkSource } from "../../../channels/infrastructure/ebay-stock-link-source";
import { STOCK_LINK_CONTROLLED_DESTINATIONS } from "../../infrastructure/stock-link-controls.repository";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { createShopifyStockLinkAdapter, createShopifyStockLinkSource } from "../../../channels/shopify-stock-link-source";
import { createDropshipEbayStockLinkAdapter } from "../../../dropship/infrastructure/dropship-ebay-stock-link.adapter";
import { createDropshipEbayStockLinkSource } from "../../../dropship/infrastructure/dropship-ebay-stock-link-source";
import type { StockLinkSupportedStatus } from "@shared/types/stock-link";

// Channels PR2 (PLAN-CH2 v4.1 §7.3): what each Channel Inventory stock-link control changes (pure), and the service
// that validates, names the actor, injects the clock and logs. The writes themselves run against PostgreSQL in
// stock-link.integration.test.ts (PG 15).

const NOW = new Date("2026-10-27T12:00:00.000Z");
const state = (overrides: Partial<StockLinkControlDestinationState> = {}): StockLinkControlDestinationState => ({
  autoLinkEnabled: true, pausedUntil: null, haltedAt: null, retiresHeld: false, ...overrides });

describe("planStockLinkControl", () => {
  it("rechecks historical status-ineligible waits only for Shopify channel destinations", () => {
    expect(stockLinkCheckAgainWaitingReasons({ destinationKind: "channel_connection", providerKey: "shopify" }))
      .toEqual(["STOCK_LINK_NOT_ON_SALE"]);
    for (const providerKey of ["ebay", "walmart", "unknown", null]) {
      expect(stockLinkCheckAgainWaitingReasons({ destinationKind: "channel_connection", providerKey })).toEqual([]);
    }
    expect(stockLinkCheckAgainWaitingReasons({ destinationKind: "dropship_store_connection", providerKey: "shopify" })).toEqual([]);
  });

  it("turns the switch off and on, and changes nothing when it is already in that position", () => {
    expect(planStockLinkControl({ kind: "switch", enabled: false }, state(), NOW))
      .toEqual({ changed: true, autoLinkEnabled: false, releaseRetires: false, resumePause: false, clearHalt: false, makeRowsDue: false });
    expect(planStockLinkControl({ kind: "switch", enabled: true }, state({ autoLinkEnabled: false }), NOW))
      .toMatchObject({ changed: true, autoLinkEnabled: true });
    expect(planStockLinkControl({ kind: "switch", enabled: true }, state(), NOW)).toMatchObject({ changed: false, autoLinkEnabled: true });
    expect(planStockLinkControl({ kind: "switch", enabled: false }, state({ autoLinkEnabled: false }), NOW).changed).toBe(false);
  });

  it("never touches holds, pauses, halts or rows from the switch", () => {
    const plan = planStockLinkControl({ kind: "switch", enabled: false },
      state({ retiresHeld: true, pausedUntil: new Date(NOW.getTime() + 60_000), haltedAt: NOW }), NOW);
    expect(plan).toMatchObject({ releaseRetires: false, resumePause: false, clearHalt: false, makeRowsDue: false });
  });

  it("Continue releases held retires and retries a pause still in force; nothing held or paused changes nothing", () => {
    expect(planStockLinkControl({ kind: "continue" }, state({ retiresHeld: true }), NOW))
      .toMatchObject({ changed: true, releaseRetires: true, resumePause: false, autoLinkEnabled: true });
    expect(planStockLinkControl({ kind: "continue" }, state({ pausedUntil: new Date(NOW.getTime() + 1) }), NOW))
      .toMatchObject({ changed: true, releaseRetires: false, resumePause: true });
    expect(planStockLinkControl({ kind: "continue" }, state({ retiresHeld: true, pausedUntil: new Date(NOW.getTime() + 1) }), NOW))
      .toMatchObject({ changed: true, releaseRetires: true, resumePause: true });
    // A pause that has run out is retried by the next tick anyway (boundary: until = now is over).
    expect(planStockLinkControl({ kind: "continue" }, state({ pausedUntil: NOW }), NOW).changed).toBe(false);
    expect(planStockLinkControl({ kind: "continue" }, state(), NOW).changed).toBe(false);
    expect(planStockLinkControl({ kind: "continue" }, state({ haltedAt: NOW }), NOW)).toMatchObject({ changed: false, clearHalt: false });
  });

  it("Check again always makes rows due and clears a halt only when halted", () => {
    expect(planStockLinkControl({ kind: "check_again" }, state(), NOW))
      .toEqual({ changed: true, autoLinkEnabled: true, releaseRetires: false, resumePause: false, clearHalt: false, makeRowsDue: true });
    expect(planStockLinkControl({ kind: "check_again" }, state({ haltedAt: NOW, autoLinkEnabled: false }), NOW))
      .toMatchObject({ changed: true, clearHalt: true, makeRowsDue: true, autoLinkEnabled: false });
  });

  it("names one audit action per control (§7.3)", () => {
    expect(STOCK_LINK_CONTROL_AUDIT_ACTIONS).toEqual({
      switch: "inventory_availability.stock_link.switch_changed",
      continue: "inventory_availability.stock_link.continued",
      check_again: "inventory_availability.stock_link.check_requested",
    });
  });
});

describe("the controlled destinations", () => {
  it("are exactly the destinations the composition registers a binding for (Shopify; Dropship eBay, PR3; Walmart and Card Shellz eBay, PR4)", () => {
    const adapter = createShopifyStockLinkAdapter({ connections: {} as never, clock: () => NOW });
    const source = createShopifyStockLinkSource();
    const dropshipAdapter = createDropshipEbayStockLinkAdapter({ destinations: {} as never, credentials: {} as never, clock: () => NOW });
    const dropshipSource = createDropshipEbayStockLinkSource();
    const walmartAdapter = createWalmartStockLinkAdapter({ channels: {} as never, clock: () => NOW });
    const walmartSource = createWalmartStockLinkSource();
    const ebayAdapter = createChannelEbayStockLinkAdapter({ ebay: {} as never, clock: () => NOW });
    const ebaySource = createChannelEbayStockLinkSource();
    expect(STOCK_LINK_CONTROLLED_DESTINATIONS).toEqual([
      { destinationKind: adapter.destinationKind, providerKey: adapter.providerKey },
      { destinationKind: dropshipAdapter.destinationKind, providerKey: dropshipAdapter.providerKey },
      { destinationKind: walmartAdapter.destinationKind, providerKey: walmartAdapter.providerKey },
      { destinationKind: ebayAdapter.destinationKind, providerKey: ebayAdapter.providerKey },
    ]);
    expect([walmartSource.destinationKind, walmartSource.providerKey]).toEqual([walmartAdapter.destinationKind, walmartAdapter.providerKey]);
    expect([ebaySource.destinationKind, ebaySource.providerKey]).toEqual([ebayAdapter.destinationKind, ebayAdapter.providerKey]);
    expect([source.destinationKind, source.providerKey]).toEqual([adapter.destinationKind, adapter.providerKey]);
    expect([dropshipSource.destinationKind, dropshipSource.providerKey]).toEqual([dropshipAdapter.destinationKind, dropshipAdapter.providerKey]);
  });
});

describe("StockLinkControlsService", () => {
  const status = (overrides: Partial<StockLinkSupportedStatus> = {}): StockLinkSupportedStatus => ({ supported: true,
    publicationTargetId: 5, autoLinkEnabled: true, revision: "3", counts: { linked: 2, waiting: 1, flagged: 0, error: 0 },
    paused: null, halted: null, retiresHeld: null, ...overrides });
  const snapshot = { autoLinkEnabled: true, revision: "3", paused: null, halted: null, retiresReleased: null };
  function harness(outcome: Partial<StockLinkControlOutcome> = {}, clock: () => Date = () => NOW, runnerOff?: () => boolean) {
    const commands: StockLinkControlCommand[] = [];
    const store: StockLinkControlsStore = {
      readStatus: vi.fn(async (publicationTargetId: number) => status({ publicationTargetId })),
      apply: vi.fn(async (command: StockLinkControlCommand) => {
        commands.push(command);
        return { kind: command.request.kind, changed: true, before: snapshot, after: { ...snapshot, revision: "4" },
          productVariantIdsMadeDue: [], status: status({ revision: "4" }), ...outcome };
      }),
    };
    const log = { info: vi.fn(), debug: vi.fn() };
    return { service: new StockLinkControlsService(store, clock, log, runnerOff), store, commands, log };
  }

  it("reads a status by a canonical decimal id and refuses anything else before the store", async () => {
    const { service, store } = harness();
    await expect(service.status({ publicationTargetId: "5" })).resolves.toMatchObject({ supported: true, publicationTargetId: 5 });
    expect(store.readStatus).toHaveBeenCalledWith(5, NOW);
    for (const bad of ["05", "-5", "5e1", "", "2147483648", undefined]) {
      await expect(service.status({ publicationTargetId: bad })).rejects.toMatchObject({ status: 400, code: "STOCK_LINK_CONTROL_INVALID_REQUEST" });
    }
    await expect(service.status({ publicationTargetId: ["5", "6"] })).rejects.toBeInstanceOf(InventoryAvailabilityMasterDataError);
    expect(store.readStatus).toHaveBeenCalledTimes(1);
  });

  it("says in every supported answer whether the server's kill switch stops linking (review CMP-1)", async () => {
    let off = true;
    const { service } = harness({}, () => NOW, () => off);
    await expect(service.status({ publicationTargetId: "5" })).resolves.toMatchObject({ runnerOff: true });
    await expect(service.checkAgain({ publicationTargetId: 5, expectedRevision: "3" }, "operator-1")).resolves.toMatchObject({ runnerOff: true });
    off = false;
    await expect(service.status({ publicationTargetId: "5" })).resolves.toMatchObject({ runnerOff: false });
    // Without the composition's switch reader the runner counts as running.
    await expect(harness().service.status({ publicationTargetId: "5" })).resolves.toMatchObject({ runnerOff: false });
  });

  it("the composition reads the runner's own switches (STOCK_LINK_AUTO_DISABLED, DISABLE_SCHEDULERS)", () => {
    expect(stockLinkRunnerDisableReason({})).toBeNull();
    expect(stockLinkRunnerDisableReason({ STOCK_LINK_AUTO_DISABLED: "true" })).toBe("STOCK_LINK_AUTO_DISABLED=true");
    expect(stockLinkRunnerDisableReason({ DISABLE_SCHEDULERS: "true" })).toBe("DISABLE_SCHEDULERS=true");
    const routes = readFileSync(join(process.cwd(), "server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts"), "utf8");
    expect(routes).toContain("() => stockLinkRunnerDisableReason() !== null");
  });

  it("answers supported: false as the store reports it", async () => {
    const { service, store } = harness();
    vi.mocked(store.readStatus).mockResolvedValueOnce({ supported: false, publicationTargetId: 9 });
    await expect(service.status({ publicationTargetId: "9" })).resolves.toEqual({ supported: false, publicationTargetId: 9 });
  });

  it("passes each control to the store with the actor, the injected clock, the revision and a normalised reason", async () => {
    const { service, commands } = harness();
    await service.setSwitch({ publicationTargetId: 5, enabled: false, expectedRevision: "3", reason: "  Store migration  " }, " operator-1 ");
    await service.setSwitch({ publicationTargetId: 5, enabled: true, expectedRevision: "0", reason: "   " }, "operator-1");
    await service.continue({ publicationTargetId: 5, expectedRevision: "4" }, "operator-1");
    await service.checkAgain({ publicationTargetId: 5, expectedRevision: "5" }, "operator-1");
    expect(commands).toEqual([
      { publicationTargetId: 5, expectedRevision: "3", request: { kind: "switch", enabled: false }, reason: "Store migration",
        actorId: "operator-1", occurredAt: NOW },
      { publicationTargetId: 5, expectedRevision: "0", request: { kind: "switch", enabled: true }, reason: null, actorId: "operator-1", occurredAt: NOW },
      { publicationTargetId: 5, expectedRevision: "4", request: { kind: "continue" }, reason: null, actorId: "operator-1", occurredAt: NOW },
      { publicationTargetId: 5, expectedRevision: "5", request: { kind: "check_again" }, reason: null, actorId: "operator-1", occurredAt: NOW },
    ]);
  });

  it("refuses malformed requests, a missing actor and an invalid clock before the store", async () => {
    const { service, store } = harness();
    const invalid = [
      () => service.setSwitch({ publicationTargetId: 5, enabled: "no", expectedRevision: "3" }, "operator-1"),
      () => service.setSwitch({ publicationTargetId: 5, enabled: true, expectedRevision: "03" }, "operator-1"),
      () => service.setSwitch({ publicationTargetId: 5, enabled: true, expectedRevision: "3", extra: 1 }, "operator-1"),
      () => service.continue({ publicationTargetId: 0, expectedRevision: "3" }, "operator-1"),
      () => service.checkAgain({ publicationTargetId: 5 }, "operator-1"),
      () => service.checkAgain({ publicationTargetId: 5, expectedRevision: "3", reason: "x" }, "operator-1"),
    ];
    for (const call of invalid) await expect(call()).rejects.toMatchObject({ status: 400, code: "STOCK_LINK_CONTROL_INVALID_REQUEST" });
    await expect(service.continue({ publicationTargetId: 5, expectedRevision: "3" }, "  ")).rejects.toMatchObject({ status: 401 });
    await expect(service.continue({ publicationTargetId: 5, expectedRevision: "3" }, "x".repeat(101))).rejects.toMatchObject({ status: 401 });
    const broken = harness({}, () => new Date(Number.NaN));
    await expect(broken.service.continue({ publicationTargetId: 5, expectedRevision: "3" }, "operator-1"))
      .rejects.toMatchObject({ status: 500, code: "STOCK_LINK_CONTROL_CLOCK_INVALID" });
    expect(store.apply).not.toHaveBeenCalled();
    expect(broken.store.apply).not.toHaveBeenCalled();
  });

  it("logs a change at INFO with before and after, and an unchanged control at DEBUG only", async () => {
    const changed = harness({ productVariantIdsMadeDue: [101, 102] });
    await expect(changed.service.checkAgain({ publicationTargetId: 5, expectedRevision: "3" }, "operator-1"))
      .resolves.toMatchObject({ revision: "4" });
    expect(changed.log.info).toHaveBeenCalledWith("inventory_availability.stock_link.control", expect.objectContaining({
      publication_target_id: 5, control: "check_again", actor: "operator-1", outcome: "changed", rows_made_due: 2,
      before: expect.objectContaining({ revision: "3" }), after: expect.objectContaining({ revision: "4" }) }));
    expect(changed.log.debug).not.toHaveBeenCalled();
    const unchanged = harness({ changed: false, status: status() });
    await unchanged.service.continue({ publicationTargetId: 5, expectedRevision: "3" }, "operator-1");
    expect(unchanged.log.info).not.toHaveBeenCalled();
    expect(unchanged.log.debug).toHaveBeenCalledWith("inventory_availability.stock_link.control",
      expect.objectContaining({ control: "continue", outcome: "unchanged" }));
  });

  it("passes the store's refusals through unchanged (stale revision, busy, not found)", async () => {
    const { service, store } = harness();
    const refusal = new InventoryAvailabilityMasterDataError(409, "STOCK_LINK_DESTINATION_STALE", "Reload.");
    vi.mocked(store.apply).mockRejectedValueOnce(refusal);
    await expect(service.setSwitch({ publicationTargetId: 5, enabled: false, expectedRevision: "2" }, "operator-1")).rejects.toBe(refusal);
  });

  it("refuses a store answer that breaks the contract instead of passing it on", async () => {
    const { service } = harness({ status: { ...status(), revision: "x" } });
    await expect(service.checkAgain({ publicationTargetId: 5, expectedRevision: "3" }, "operator-1")).rejects.toThrow();
  });
});
