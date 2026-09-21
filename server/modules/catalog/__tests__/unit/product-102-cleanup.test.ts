import { describe, expect, it, vi } from "vitest";
import {
  Product102CleanupService,
  product102RequestHash,
  product102StateHash,
} from "../../application/product-102-cleanup.service";
import { parseProduct102CleanupArguments } from "../../interfaces/product-102-cleanup-command";
import { product102CleanupCommandSchema } from "../../domain/product-102-cleanup";

describe("bounded product 102 cleanup command", () => {
  it("defaults to preview and separates verification from execution", () => {
    expect(parseProduct102CleanupArguments([])).toEqual({ mode: "preview" });
    expect(parseProduct102CleanupArguments(["--preview"])).toEqual({
      mode: "preview",
    });
    expect(parseProduct102CleanupArguments(["--verify"])).toEqual({
      mode: "verify",
    });
    expect(
      parseProduct102CleanupArguments([
        "--execute",
        "--expected-hash",
        "a".repeat(64),
        "--actor-id",
        "owner",
        "--approval",
        "Exact owner approval",
      ]),
    ).toEqual({
      mode: "execute",
      command: {
        expectedHash: "a".repeat(64),
        actorId: "owner",
        approval: "Exact owner approval",
      },
    });
  });
  it.each([
    ["--execute"],
    ["--preview", "--execute"],
    ["--verify", "--actor-id", "owner"],
    ["--unknown"],
    ["102"],
    [
      "--execute",
      "--actor-id",
      "owner",
      "--actor-id",
      "other",
      "--approval",
      "Some approval",
    ],
    [
      "--execute",
      "--expected-hash",
      "invalid",
      "--actor-id",
      "owner",
      "--approval",
      "Some approval",
    ],
    [
      "--execute",
      "--expected-hash",
      "a".repeat(64),
      "--actor-id",
      " ",
      "--approval",
      "Some approval",
    ],
    [
      "--execute",
      "--expected-hash",
      "a".repeat(64),
      "--actor-id",
      "owner",
      "--approval",
      "short",
    ],
  ])(
    "rejects incomplete, conflicting or unknown arguments %j",
    (...args: string[]) => {
      expect(() => parseProduct102CleanupArguments(args)).toThrow();
    },
  );
  it("rejects extra execution input instead of allowing a different product or quantity mutation", () => {
    expect(() =>
      product102CleanupCommandSchema.parse({
        expectedHash: "a".repeat(64),
        actorId: "owner",
        approval: "Owner approval",
        sourceProductId: 999,
        receivingSize: 1000,
      }),
    ).toThrow();
  });
  it("hashes exact financial JSON text without rounding and includes both schema and command approval", () => {
    expect(product102StateHash('{"cents":9007199254740993}', "{}")).not.toBe(
      product102StateHash('{"cents":9007199254740992}', "{}"),
    );
    expect(product102StateHash("{}", '{"guard":true}')).not.toBe(
      product102StateHash("{}", '{"guard":false}'),
    );
    const command = {
      expectedHash: "a".repeat(64),
      actorId: "owner",
      approval: "Original approval",
    };
    expect(product102RequestHash(command)).toBe(
      product102RequestHash({
        approval: command.approval,
        actorId: command.actorId,
        expectedHash: command.expectedHash,
      }),
    );
    expect(product102RequestHash(command)).not.toBe(
      product102RequestHash({ ...command, approval: "Changed approval" }),
    );
  });
  it("rejects an invalid injected clock or invalid input before opening a transaction", async () => {
    const transaction = vi.fn(async () => {
      throw new Error("Should not connect");
    });
    const service = new Product102CleanupService(
      { transaction },
      () => new Date("invalid"),
    );
    await expect(service.preview()).rejects.toMatchObject({
      code: "CLEANUP_INVALID_CLOCK",
    });
    await expect(service.apply({})).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
