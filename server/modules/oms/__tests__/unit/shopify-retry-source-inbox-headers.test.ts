import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKER_SRC = readFileSync(
  resolve(__dirname, "../../webhook-retry.worker.ts"),
  "utf-8",
);

describe("Shopify retry source inbox headers", () => {
  it("replays Shopify webhooks with original inbox identity headers", () => {
    expect(WORKER_SRC).toMatch(/async function getSourceInboxReplayHeaders/);
    expect(WORKER_SRC).toMatch(/FROM oms\.webhook_inbox/);
    expect(WORKER_SRC).toMatch(/x-shopify-webhook-id/);
    expect(WORKER_SRC).toMatch(/const sourceHeaders = await getSourceInboxReplayHeaders\(defaultDb, item\.sourceInboxId\)/);
    expect(WORKER_SRC).toMatch(/\.\.\.sourceHeaders/);
  });
});
