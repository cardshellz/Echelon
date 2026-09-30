import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { rejectLegacyLocationMapping } from "../../legacy-location-mapping.handler";
import { readChannelFulfillmentWarehouses } from "../../channel-fulfillment-warehouses.reader";

describe("legacy channel configuration retirement", () => {
  it("returns a repeatable explicit retirement response without reading or mutating the request", () => {
    const request = { get body() { throw new Error("retired mapping must not inspect a write payload"); } } as Request;
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    rejectLegacyLocationMapping(request, response as unknown as Response);
    rejectLegacyLocationMapping(request, response as unknown as Response);
    expect(response.status).toHaveBeenCalledWith(410);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "LEGACY_SHOPIFY_LOCATION_MAPPING_RETIRED", replacementPath: "/channels/inventory",
    }));
    expect(response.json.mock.calls[0]).toEqual(response.json.mock.calls[1]);
  });
  it("keeps the old mapping route permission protected and binds only the retirement handler", () => {
    const routes = readFileSync("server/modules/channels/channels.routes.ts", "utf8");
    expect(routes).toContain('app.post("/api/channels/:id/map-locations", requirePermission("channels", "edit"), rejectLegacyLocationMapping);');
    expect(routes).not.toContain("storage.updateWarehouse(");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])("rejects invalid channel %s before reading", async channelId => {
    const query = vi.fn();
    await expect(readChannelFulfillmentWarehouses({ query }, { channelId })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not turn database errors into an empty or legacy allowlist", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(readChannelFulfillmentWarehouses({ query }, { channelId: 36 })).rejects.toThrow("database unavailable");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("removes the dead sidebar entry while preserving Channel Inventory", () => {
    const source = readFileSync("client/src/components/layout/AppShell.tsx", "utf8");
    expect(source).not.toContain('href: "/channel-allocation"');
    expect(source).toContain('href: "/channels/inventory"');
  });
});
