import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RETURN_CASES_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/pages/ReturnCases.tsx"),
  "utf8",
);
const DROPSHIP_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/pages/Dropship.tsx"),
  "utf8",
);

describe("first-class returns create entry", () => {
  it("uses the canonical case creator and limits legacy dropship UI to inspection", () => {
    expect(RETURN_CASES_SOURCE).toContain("<ReturnCaseAdminPanel />");
    expect(RETURN_CASES_SOURCE).toContain("showCreatePanel={false}");
    expect(RETURN_CASES_SOURCE).toContain("Dropship receiving and inspection");
    expect(RETURN_CASES_SOURCE).not.toContain(
      "Create and inspect dropship RMAs",
    );
  });

  it("does not run legacy creator setup queries when its panel is disabled", () => {
    expect(DROPSHIP_SOURCE).toContain("{showCreatePanel && (");
    expect(DROPSHIP_SOURCE.match(/enabled: showCreatePanel,/g)).toHaveLength(4);
    expect(DROPSHIP_SOURCE).toMatch(
      /showCreatePanel\s*&&\s*selectedReturnVendorId !== null/,
    );
  });
});
