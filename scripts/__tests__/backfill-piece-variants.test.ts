import { describe, expect, it } from "vitest";

import { parsePieceVariantBackfillArgs } from "../backfill-piece-variants";

describe("piece variant backfill CLI", () => {
  it("defaults to read-only preview", () => {
    expect(parsePieceVariantBackfillArgs([])).toEqual({
      execute: false,
      actor: null,
      previewHash: null,
    });
  });

  it("requires an actor and exact preview hash for apply", () => {
    expect(() => parsePieceVariantBackfillArgs(["--execute"])).toThrow(
      "--actor is required",
    );
    expect(() => parsePieceVariantBackfillArgs([
      "--execute",
      "--actor=user-1",
    ])).toThrow("--preview-hash is required");
    expect(parsePieceVariantBackfillArgs([
      "--execute",
      "--actor=user-1",
      `--preview-hash=${"A".repeat(64)}`,
    ])).toEqual({
      execute: true,
      actor: "user-1",
      previewHash: "a".repeat(64),
    });
  });

  it("rejects malformed hashes, oversized actors, write-only flags during preview, and unknown arguments", () => {
    expect(() => parsePieceVariantBackfillArgs([
      "--execute",
      "--actor=user-1",
      "--preview-hash=not-a-hash",
    ])).toThrow("SHA-256");
    expect(() => parsePieceVariantBackfillArgs([
      "--execute",
      `--actor=${"u".repeat(101)}`,
      `--preview-hash=${"a".repeat(64)}`,
    ])).toThrow("100 characters");
    expect(() => parsePieceVariantBackfillArgs([
      "--actor=user-1",
    ])).toThrow("only valid with --execute");
    expect(() => parsePieceVariantBackfillArgs([
      "--force",
    ])).toThrow("Unknown argument");
  });
});
