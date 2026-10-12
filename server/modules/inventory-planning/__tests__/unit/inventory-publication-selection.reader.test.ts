import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";

const readers = vi.hoisted(() => ({ channel: vi.fn(), dropship: vi.fn() }));
vi.mock("../../../channels/channel-stock-selection", async importOriginal => ({
  ...await importOriginal<typeof import("../../../channels/channel-stock-selection")>(), readChannelStockSelection: readers.channel,
}));
vi.mock("../../../dropship/stock-publication-selection", async importOriginal => ({
  ...await importOriginal<typeof import("../../../dropship/stock-publication-selection")>(), readDropshipListingStockSelection: readers.dropship,
}));

import { ChannelStockSelectionError } from "../../../channels/channel-stock-selection";
import { DropshipError } from "../../../dropship/stock-publication-selection";
import { InventoryPublicationSelectionError, readPublicationStockSelection, type StockSelectionDestination } from "../../infrastructure/inventory-publication-selection.reader";

const client: StockSelectionQueryClient = { query: async () => ({ rows: [] }) };
const channel: StockSelectionDestination = { destinationKind: "channel_connection", channelId: 67, channelConnectionId: 9, dropshipStoreConnectionId: null };
const store: StockSelectionDestination = { destinationKind: "dropship_store_connection", channelId: 67, channelConnectionId: null, dropshipStoreConnectionId: 12 };
const input = { productId: 20, productVariantIds: [101], now: new Date("2026-10-12T12:00:00Z") };
const selection = { productId: 20, fingerprint: "a".repeat(64), variants: [{ productVariantId: 101, action: "publish", reason: "Selected by listing owner", blockers: [] }] };
beforeEach(() => { readers.channel.mockReset().mockResolvedValue(selection); readers.dropship.mockReset().mockResolvedValue(selection); });

describe("public Inventory selection error boundary", () => {
  it.each(["CHANNEL_SELECTION_CONNECTION_UNRESOLVED", "CHANNEL_SELECTION_JOB_SCOPE_CHANGED", "CHANNEL_SELECTION_AMBIGUOUS"])("preserves the verified Channel owner diagnostic %s", async code => {
    const cause = new ChannelStockSelectionError(code, "Review the exact saved channel connection and listing mapping.");
    readers.channel.mockRejectedValueOnce(cause);
    await expect(readPublicationStockSelection(client, channel, input)).rejects.toMatchObject({
      name: "InventoryPublicationSelectionError", code, message: cause.message, cause,
    });
  });
  it.each(["DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "DROPSHIP_STOCK_STORE_NOT_FOUND", "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID"])("preserves the verified Dropship owner diagnostic %s without exporting its context", async code => {
    const cause = new DropshipError(code, "Review the affected store selection.", { privateInternalDetail: "not public" });
    readers.dropship.mockRejectedValueOnce(cause);
    try { await readPublicationStockSelection(client, store, input); throw new Error("Expected owner refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(InventoryPublicationSelectionError);
      expect(error).toMatchObject({ code, message: cause.message, cause });
      expect(error).not.toHaveProperty("context");
    }
  });
  it.each(["sql", "validation", "unrelated_dropship", "unknown_channel"])("does not make %s error prose public", async kind => {
    const error = kind === "sql" ? Object.assign(new Error("private database query details"), { code: "CHANNEL_SELECTION_AMBIGUOUS" })
      : kind === "validation" ? z.object({ id: z.number() }).safeParse({ id: "private value" }).error!
      : kind === "unknown_channel" ? new ChannelStockSelectionError("CHANNEL_INTERNAL_UNKNOWN", "private owner detail")
      : new DropshipError("DROPSHIP_INTERNAL_UNKNOWN", "private owner detail");
    readers.channel.mockRejectedValueOnce(error);
    await expect(readPublicationStockSelection(client, channel, input)).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(InventoryPublicationSelectionError);
  });
  it("passes the exact caller scope to its owner without inventing stock or changing the input", async () => {
    const before = structuredClone(input);
    expect(await readPublicationStockSelection(client, channel, input)).toEqual(selection);
    expect(readers.channel).toHaveBeenCalledWith(client, { channelId: 67, channelConnectionId: 9, productId: 20, productVariantIds: [101] });
    expect(input).toEqual(before);
  });
  it("retains public errors for invalid destination and incomplete owner identities", async () => {
    await expect(readPublicationStockSelection(client, { ...channel, dropshipStoreConnectionId: 12 }, input))
      .rejects.toMatchObject({ name: "InventoryPublicationSelectionError", code: "PUBLICATION_SELECTION_DESTINATION_INVALID" });
    readers.channel.mockResolvedValueOnce({ ...selection, variants: [] });
    await expect(readPublicationStockSelection(client, channel, input))
      .rejects.toMatchObject({ name: "InventoryPublicationSelectionError", code: "PUBLICATION_SELECTION_IDENTITY_INCOMPLETE" });
  });
});
