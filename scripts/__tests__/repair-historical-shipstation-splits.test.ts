import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseFlags } from "../repair-historical-shipstation-splits";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/repair-historical-shipstation-splits.ts"),
  "utf8",
);

describe("repair-historical-shipstation-splits CLI", () => {
  it("routes repaired labels through carrier tracking instead of direct fulfillment materialization", () => {
    expect(source).toContain("observeShipStationLabel");
    expect(source).toContain("reconcileShipStationLabel");
    expect(source).toContain("proveProviderPackageLinks");
    expect(source).toContain("hydrateShipStationTrackingIdentity");
    expect(source).not.toContain("materializePhysicalPackage");
    expect(source).not.toContain("projectPhysicalShipment");
  });
  it("defaults to a bounded dry-run", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 25,
      providerShipmentId: null,
      delayMs: 250,
      json: false,
    });
  });

  it("parses a full execute authorization envelope", () => {
    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--confirm-count=268",
      "--operator=owner@cardshellz.com",
      "--reason=historical split repair",
      "--idempotency-key=historical-split-repair-2026-07-30",
      "--delay-ms=500",
      "--json",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      confirmCount: 268,
      operator: "owner@cardshellz.com",
      reason: "historical split repair",
      idempotencyKey: "historical-split-repair-2026-07-30",
      delayMs: 500,
      json: true,
    });
  });

  it("requires an exact confirmation count for execute", () => {
    expect(() => parseFlags(["--execute"])).toThrow(
      "--confirm-count is required with --execute",
    );
  });

  it.each([
    ["--unknown", "Unknown flag"],
    ["--limit=0", "--limit must be"],
    ["--provider-shipment-id=-1", "--provider-shipment-id must be"],
    ["--delay-ms=-1", "--delay-ms must be"],
  ])("rejects invalid flag %s", (flag, message) => {
    expect(() => parseFlags([flag])).toThrow(message);
  });
});