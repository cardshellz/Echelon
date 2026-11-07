import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SalesStatusChangeResult } from "@shared/types/inventory-sales-status";
import { canonicalJson } from "@shared/utils/canonical-json";

import { SalesStatusService, type SalesStatusCommand, type SalesStatusStore } from "../../application/inventory-sales-status.service";

const NOW = new Date("2026-11-07T15:00:00.000Z");
const SKU_EVERYWHERE = { channelId: null, productId: 11, productVariantId: 22 };
const REQUEST = {
  changes: [{ scope: SKU_EVERYWHERE, status: "stopped" as const, expectedRevision: null }],
  note: "Supplier recall",
  idempotencyKey: "sales-status:test-1",
};

function result(overrides: Partial<SalesStatusChangeResult> = {}): SalesStatusChangeResult {
  return {
    changes: [{ scopeKey: "all:variant:22", scope: SKU_EVERYWHERE, before: null,
      after: { status: "stopped", revision: "41" }, changed: true }],
    affectedProductIds: [11],
    republished: [{ productId: 11, publicationRows: 2, skippedDestinations: [] }],
    queued: [],
    alreadyApplied: false,
    providerWriteAttempted: false,
    ...overrides,
  };
}

function store(overrides: Partial<SalesStatusStore> = {}) {
  return {
    change: vi.fn(async (_command: SalesStatusCommand) => result()),
    readProduct: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe("SalesStatusService.change", () => {
  it("normalizes the request, binds the actor and clock, and hashes actor plus request into the identity", async () => {
    const backing = store();
    const service = new SalesStatusService(backing, { now: () => NOW }, logger());

    await expect(service.change({ ...REQUEST, note: `  ${REQUEST.note} `, idempotencyKey: ` ${REQUEST.idempotencyKey} ` }, " admin "))
      .resolves.toEqual(result());

    expect(backing.change).toHaveBeenCalledWith({
      ...REQUEST,
      actorId: "admin",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_sales_status_change", actorId: "admin", request: REQUEST,
      }), "utf8").digest("hex"),
    });
  });

  it("treats a blank note as no note, and hashes a different actor or status differently", async () => {
    const change = vi.fn(async (_command: SalesStatusCommand) => result());
    const service = new SalesStatusService(store({ change }), { now: () => NOW }, logger());
    await service.change({ ...REQUEST, note: "   " }, "admin");
    await service.change({ ...REQUEST, note: "   " }, "operator-2");
    await service.change({ ...REQUEST, note: "   ", changes: [{ ...REQUEST.changes[0], status: "inherit" }] }, "admin");
    const commands = change.mock.calls.map(([command]) => command);
    expect(commands[0]!.note).toBeNull();
    expect(new Set(commands.map((command) => command.requestHash)).size).toBe(3);
  });

  it.each([
    ["no changes", { ...REQUEST, changes: [] }],
    ["a repeated scope", { ...REQUEST, changes: [REQUEST.changes[0], { ...REQUEST.changes[0], status: "selling" }] }],
    ["an unknown status", { ...REQUEST, changes: [{ ...REQUEST.changes[0], status: "paused" }] }],
    // Selling everywhere is the default; storing it could never override a stop.
    ["Selling on all channels", { ...REQUEST, changes: [{ ...REQUEST.changes[0], status: "selling" }] }],
    ["a fractional id", { ...REQUEST, changes: [{ ...REQUEST.changes[0], scope: { ...SKU_EVERYWHERE, productVariantId: 2.5 } }] }],
    ["a zero revision", { ...REQUEST, changes: [{ ...REQUEST.changes[0], expectedRevision: "0" }] }],
    ["an extra field", { ...REQUEST, reason: "required?" }],
    ["a missing key", { changes: REQUEST.changes }],
    ["an overlong note", { ...REQUEST, note: "x".repeat(501) }],
  ])("refuses %s before the store runs", async (_label, input) => {
    const backing = store();
    await expect(new SalesStatusService(backing, { now: () => NOW }, logger()).change(input, "admin"))
      .rejects.toMatchObject({ status: 400, code: "SALES_STATUS_INVALID_REQUEST", classification: "permanent" });
    expect(backing.change).not.toHaveBeenCalled();
  });

  it("refuses more than the change limit in one command", async () => {
    const changes = Array.from({ length: 501 }, (_, index) => ({
      scope: { channelId: null, productId: 11, productVariantId: index + 1 }, status: "stopped", expectedRevision: null,
    }));
    await expect(new SalesStatusService(store(), { now: () => NOW }, logger()).change({ ...REQUEST, changes }, "admin"))
      .rejects.toMatchObject({ code: "SALES_STATUS_INVALID_REQUEST" });
  });

  it("requires an authenticated actor and a valid clock", async () => {
    await expect(new SalesStatusService(store(), { now: () => NOW }, logger()).change(REQUEST, undefined))
      .rejects.toMatchObject({ status: 401, code: "SALES_STATUS_ACTOR_REQUIRED" });
    await expect(new SalesStatusService(store(), { now: () => new Date(Number.NaN) }, logger()).change(REQUEST, "admin"))
      .rejects.toMatchObject({ status: 500, code: "SALES_STATUS_CLOCK_INVALID", classification: "transient" });
  });

  it("keeps the retry identity when a committed result cannot be verified", async () => {
    const backing = store({ change: vi.fn(async () => ({ ...result(), providerWriteAttempted: true }) as never) });
    await expect(new SalesStatusService(backing, { now: () => NOW }, logger()).change(REQUEST, "admin"))
      .rejects.toMatchObject({ status: 500, code: "SALES_STATUS_RESULT_INVALID", classification: "transient" });
  });

  it("logs each changed scope with before and after, and warns about stock that did not update here", async () => {
    const log = logger();
    const backing = store({ change: vi.fn(async () => result({
      republished: [{ productId: 11, publicationRows: 1, skippedDestinations: [
        { publicationTargetId: 3, channelId: 67, channelName: "Ebay", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING" }] }],
      queued: [{ productId: 12, reason: "could_not_republish", errorCode: "CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH" }],
      affectedProductIds: [11, 12],
    })) });
    await new SalesStatusService(backing, { now: () => NOW }, log).change(REQUEST, "admin");

    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({
      level: "info", event: "sales_status_changed", outcome: "applied", error_code: null, actor: "admin",
      scope_key: "all:variant:22", before: null, after: { status: "stopped", revision: "41" },
    }));
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "sales_status_republish_deferred", product_id: 12, error_code: "CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH" }));
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "sales_status_destination_skipped", publication_target_id: 3, error_code: "CANONICAL_PUBLICATION_MAPPING_MISSING" }));
  });

  it("does not repeat warnings when the same change is replayed", async () => {
    const log = logger();
    const backing = store({ change: vi.fn(async () => result({ alreadyApplied: true,
      queued: [{ productId: 11, reason: "could_not_republish", errorCode: "X" }], republished: [] })) });
    await new SalesStatusService(backing, { now: () => NOW }, log).change(REQUEST, "admin");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "sales_status_changed", outcome: "replayed" }));
  });
});

describe("SalesStatusService reads", () => {
  it("validates the product id and the view the store returns", async () => {
    const readProduct = vi.fn(async () => ({ invalid: true }));
    const service = new SalesStatusService(store({ readProduct: readProduct as never }), { now: () => NOW }, logger());
    await expect(service.readProduct("abc")).rejects.toMatchObject({ status: 400, code: "SALES_STATUS_INVALID_PRODUCT" });
    expect(readProduct).not.toHaveBeenCalled();
    await expect(service.readProduct("11")).rejects.toMatchObject({ status: 500, code: "SALES_STATUS_READ_INVALID" });
    expect(readProduct).toHaveBeenCalledWith(11);
  });

  it("lists stopped settings by default and refuses an unknown status filter", async () => {
    const list = vi.fn(async () => ({ entries: [], truncated: false }));
    const service = new SalesStatusService(store({ list }), { now: () => NOW }, logger());
    await expect(service.list({})).resolves.toEqual({ entries: [], truncated: false });
    expect(list).toHaveBeenCalledWith("stopped");
    await expect(service.list({ status: "paused" })).rejects.toMatchObject({ status: 400, code: "SALES_STATUS_INVALID_QUERY" });
  });
});
