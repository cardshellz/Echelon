import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "server/modules/returns/infrastructure/open-return-case.repository.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("open return case repository contract", () => {
  it("excludes non-shipping lines from source search, counts, and detail eligibility", () => {
    expect(source.match(/AND oi\.requires_shipping <> 0/g) ?? []).toHaveLength(4);
  });
});
