import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RETURN_CASES_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/pages/ReturnCases.tsx"),
  "utf8",
);
const RETURN_OPS_TAB_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/features/returns/ReturnOpsTab.tsx"),
  "utf8",
);
const OPEN_RETURN_CASE_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/components/returns/OpenReturnCaseDialog.tsx"),
  "utf8",
);

describe("first-class returns create entry", () => {
  it("uses the canonical case creator, limits legacy dropship UI to inspection, and decouples ReturnCases from Dropship.tsx", () => {
    expect(RETURN_CASES_SOURCE).toContain(
      'import { ReturnOpsTab } from "@/features/returns/ReturnOpsTab";',
    );
    expect(RETURN_CASES_SOURCE).not.toContain("@/pages/Dropship");
    expect(RETURN_CASES_SOURCE).toContain("<ReturnCaseAdminPanel");
    expect(RETURN_CASES_SOURCE).toContain("onOpenLegacyRma=");
    expect(RETURN_CASES_SOURCE).toContain("showCreatePanel={false}");
    expect(RETURN_CASES_SOURCE).toContain("Receiving &amp; inspection");
    expect(RETURN_CASES_SOURCE).not.toContain(
      "Create and inspect dropship RMAs",
    );
  });

  it("does not run legacy creator setup queries when its panel is disabled", () => {
    expect(RETURN_OPS_TAB_SOURCE).toContain("{showCreatePanel && (");
    expect(RETURN_OPS_TAB_SOURCE.match(/enabled: showCreatePanel,/g)).toHaveLength(4);
    expect(RETURN_OPS_TAB_SOURCE).toMatch(
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
