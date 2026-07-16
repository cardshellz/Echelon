import { describe, expect, it } from "vitest";

import {
  parseLegacyPoReceiveConfigArgs,
} from "../remediate-legacy-po-receive-config";

describe("legacy PO receive configuration CLI", () => {
  it("defaults to read-only preview", () => {
    expect(parseLegacyPoReceiveConfigArgs([])).toEqual({
      execute: false,
      actor: null,
      previewHash: null,
    });
  });

  it("requires an actor and exact preview hash for apply", () => {
    expect(() => parseLegacyPoReceiveConfigArgs(["--execute"])).toThrow(
      "--actor is required",
    );
    expect(() => parseLegacyPoReceiveConfigArgs([
      "--execute",
      "--actor=user-1",
    ])).toThrow("--preview-hash is required");
    expect(parseLegacyPoReceiveConfigArgs([
      "--execute",
      "--actor=user-1",
      `--preview-hash=${"a".repeat(64)}`,
    ])).toEqual({
      execute: true,
      actor: "user-1",
      previewHash: "a".repeat(64),
    });
  });

  it("rejects write-only flags during preview and unknown arguments", () => {
    expect(() => parseLegacyPoReceiveConfigArgs([
      "--actor=user-1",
    ])).toThrow("only valid with --execute");
    expect(() => parseLegacyPoReceiveConfigArgs([
      "--force",
    ])).toThrow("Unknown argument");
  });
});
