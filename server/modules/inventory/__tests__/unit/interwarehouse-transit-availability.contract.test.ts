import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function method(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`async ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = nextName ? source.indexOf(`async ${nextName}(`, start + 1) : source.length;
  expect(end, `${nextName ?? "end of file"} must follow ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("inter-warehouse transit availability boundary", () => {
  const atp = read("../../atp.service.ts");

  it.each([
    ["getAtpBase", "getAtpBaseByWarehouse"],
    ["getAtpBaseByWarehouse", "getDirectVariantAtpByWarehouse"],
    ["getDirectVariantAtpByWarehouse", "getDirectVariantAtp"],
    ["getDirectVariantAtp", "getAtpPerVariantByWarehouse"],
    ["getBulkAtp", undefined],
  ] as const)("keeps in-transit custody out of %s", (name, nextName) => {
    expect(method(atp, name, nextName)).toMatch(/locationType|location_type/);
    expect(method(atp, name, nextName)).toContain("in_transit");
  });

  it("keeps in-transit custody out of recipe build capacity", () => {
    const recipe = read("../../recipe-capacity.service.ts");
    expect(recipe).toMatch(/location\.location_type\s*<>\s*'in_transit'/);
  });
});
