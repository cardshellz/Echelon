import { describe, expect, it } from "vitest";

import {
  parseHistoricalSupplierEvidenceArgs,
} from "../backfill-historical-po-supplier-evidence";

describe("historical supplier evidence CLI", () => {
  it("defaults to read-only preview", () => {
    expect(parseHistoricalSupplierEvidenceArgs([])).toEqual({
      execute: false,
      actor: null,
      previewHash: null,
      excludedVendorIds: [],
    });
  });

  it("requires an actor and exact preview hash for apply", () => {
    expect(() => parseHistoricalSupplierEvidenceArgs(["--execute"])).toThrow(
      "--actor is required",
    );
    expect(() => parseHistoricalSupplierEvidenceArgs([
      "--execute",
      "--actor=user-1",
    ])).toThrow("--preview-hash is required");
    expect(parseHistoricalSupplierEvidenceArgs([
      "--execute",
      "--actor=user-1",
      `--preview-hash=${"a".repeat(64)}`,
    ])).toEqual({
      execute: true,
      actor: "user-1",
      previewHash: "a".repeat(64),
      excludedVendorIds: [],
    });
  });

  it("rejects write-only flags during preview", () => {
    expect(() => parseHistoricalSupplierEvidenceArgs([
      "--actor=user-1",
    ])).toThrow("only valid with --execute");
  });

  it("deduplicates and sorts explicit vendor exclusions", () => {
    expect(parseHistoricalSupplierEvidenceArgs([
      "--exclude-vendor-id=101",
      "--exclude-vendor-id=2",
      "--exclude-vendor-id=101",
    ])).toMatchObject({
      execute: false,
      excludedVendorIds: [2, 101],
    });
  });
});
