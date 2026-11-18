import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const DROPSHIP_ROOT = path.resolve(__dirname, "../..");

function collectTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test" || entry.name === "node_modules") {
        continue;
      }
      results.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("DRP-2: Dropship internal API boundaries (CI-03) and use-case registry retirement (COM-07)", () => {
  it("forbids production files outside server/modules/dropship from importing dropship/infrastructure/* directly (CI-03)", () => {
    const files = collectTypeScriptFiles(SERVER_ROOT).filter(
      (filePath) => !filePath.startsWith(DROPSHIP_ROOT + path.sep),
    );

    const violations: Array<{ file: string; line: string }> = [];
    const directInfraPattern = /["'][^"']*dropship\/infrastructure\//;

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (directInfraPattern.test(line)) {
          violations.push({
            file: path.relative(SERVER_ROOT, filePath).replace(/\\/g, "/"),
            line: line.trim(),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit dropship *.api.ts facades and module barrel for cross-module consumers (CI-03)", () => {
    const expectedApis = [
      "index.ts",
      "oms-channel-resolver.api.ts",
      "quantity-publication-catchup.api.ts",
      "ebay-inventory-publication.api.ts",
      "listing-preview.api.ts",
      "ebay-registration-credentials.api.ts",
      "ebay-listing-replacement.api.ts",
      "store-connection.api.ts",
      "fulfillment-tracking.api.ts",
      "return-settlement.api.ts",
      "shipping-packaging.api.ts",
      "runtime-workers.api.ts",
    ];

    for (const apiFile of expectedApis) {
      expect(fs.existsSync(path.join(DROPSHIP_ROOT, apiFile))).toBe(true);
    }
  });

  it("retires the unreferenced dropship-use-cases.ts registry (COM-07)", () => {
    expect(
      fs.existsSync(path.join(DROPSHIP_ROOT, "application/dropship-use-cases.ts")),
    ).toBe(false);
  });
});
