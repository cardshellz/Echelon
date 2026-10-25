import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { protectEbayPolicyWriteBoundary } from "../../interfaces/ebay-policy-write-boundary";

describe("catalog eBay policy write boundary", () => {
  let server: Server;
  let baseUrl: string;
  const write = vi.fn();
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    for (const operation of ["create", "update"] as const) {
      app.post(`/${operation}`, protectEbayPolicyWriteBoundary(operation), (_req, res) => {
        write();
        res.status(200).json({ success: true });
      });
    }
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("A local test HTTP address is required");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => write.mockClear());
  const send = (operation: string, body: unknown) => fetch(`${baseUrl}/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it.each([
    ["create", { name: "New product", ebayFulfillmentPolicyOverride: "hidden-policy" }],
    ["create", { name: "New product", variants: [{ sku: "PACK", ebayReturnPolicyOverride: "hidden-policy" }] }],
    ["create", { sku: "PACK", ebay_payment_policy_override: "hidden-policy" }],
    ["update", { name: "Updated product", ebayFulfillmentPolicyOverride: null }],
    ["update", { sku: "PACK", ebayPaymentPolicyOverride: "another-policy" }],
  ])("rejects unauthorized %s policy fields before the first write: %j", async (operation, payload) => {
    const response = await send(operation, payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EBAY_POLICY_OWNER_REQUIRED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("allows ordinary catalog edits without treating omitted policies as clears", async () => {
    const response = await send("update", { name: "Current name" });
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledOnce();
  });

  it("allows explicit inheritance on creation without permitting a selected policy", async () => {
    const response = await send("create", { name: "New draft", ebayFulfillmentPolicyOverride: null,
      variants: [{ sku: "NEW-PACK", ebayPaymentPolicyOverride: null }] });
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledOnce();
  });
});
