import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("orders.storage :: resolveException status column", () => {
  it("writes warehouseStatus not status when resolving an exception", () => {
    const start = STORAGE_SRC.indexOf("async resolveException(");
    const nextAsync = STORAGE_SRC.indexOf("\n  async ", start + 1);
    const resolveBlock = STORAGE_SRC.slice(start, nextAsync);
    expect(resolveBlock).toContain("updates.warehouseStatus = newStatus");
    expect(resolveBlock).not.toContain("updates.status = newStatus");
  });
});
