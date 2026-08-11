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
const OPEN_RETURN_CASE_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/components/returns/OpenReturnCaseDialog.tsx"),
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

  it("paginates returnable orders on the server and exposes a sales-channel filter", () => {
    expect(OPEN_RETURN_CASE_SOURCE).toContain('const SOURCE_ORDER_PAGE_SIZE = 25');
    expect(OPEN_RETURN_CASE_SOURCE).toContain('params.set("channelId", channelId)');
    expect(OPEN_RETURN_CASE_SOURCE).toContain('All sales channels');
    expect(OPEN_RETURN_CASE_SOURCE).toContain('Previous');
    expect(OPEN_RETURN_CASE_SOURCE).toContain('Next');
  });
});
