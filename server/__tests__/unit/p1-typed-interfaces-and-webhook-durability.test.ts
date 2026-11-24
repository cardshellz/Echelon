import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  buildShipStationWebhookInboxInput,
  buildShopifyWebhookInboxInput,
  enqueueShipStationRetry,
  enqueueWebhookInboxReplay,
} from "../../modules/oms/webhook-retry.api";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function makeReq(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("P1.4 & P1.6: Typed Module Interfaces and Single Webhook Durability Contract", () => {
  describe("P1.4: Composition root type safety and module interface contracts", () => {
    const servicesIndexPath = path.join(REPO_ROOT, "server/services/index.ts");
    const servicesSrc = fs.readFileSync(servicesIndexPath, "utf8");
    const sourceFile = ts.createSourceFile(
      servicesIndexPath,
      servicesSrc,
      ts.ScriptTarget.Latest,
      true,
    );

    it("bans all `as any` casts and `: any` annotations in server/services/index.ts", () => {
      const violations: string[] = [];

      const visit = (node: ts.Node) => {
        if (
          ts.isAsExpression(node) &&
          node.type.kind === ts.SyntaxKind.AnyKeyword
        ) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`line ${line}: as any cast (${node.getText()})`);
        } else if (
          ts.isTypeAssertionExpression(node) &&
          node.type.kind === ts.SyntaxKind.AnyKeyword
        ) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`line ${line}: <any> assertion (${node.getText()})`);
        } else if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`line ${line}: explicit any type`);
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
      expect(violations).toEqual([]);
    });

    it("types createServices(db: DrizzleDb) and wires inventorySource to inventoryCore instead of null", () => {
      expect(servicesSrc).toContain("db: DrizzleDb");
      expect(servicesSrc).toContain(
        "const inventorySource: InventorySourceContract = inventoryCore;",
      );
      expect(servicesSrc).not.toContain("const inventorySource = null");
    });

    it("exports explicit InventoryCore, WmsApi, OmsApi, and ChannelsApi module interfaces", () => {
      expect(readRepoFile("server/modules/inventory/index.ts")).toContain(
        "export type InventoryCore =",
      );
      expect(readRepoFile("server/modules/inventory/index.ts")).toContain(
        "export interface InventorySourceContract",
      );
      expect(readRepoFile("server/modules/wms/index.ts")).toContain(
        "export interface WmsApi",
      );
      expect(readRepoFile("server/modules/oms/index.ts")).toContain(
        "export interface OmsApi",
      );
      expect(readRepoFile("server/modules/channels/index.ts")).toContain(
        "export interface ChannelsApi",
      );

      expect(servicesSrc).toContain("InventoryCore");
      expect(servicesSrc).toContain("WmsApi");
      expect(servicesSrc).toContain("OmsApi");
      expect(servicesSrc).toContain("ChannelsApi");
    });
  });

  describe("P1.6: Single webhook durability contract (persist to inbox -> ACK -> process from inbox)", () => {
    it("builds bounded, deterministic ShipStation SHIP_NOTIFY inbox receipts", () => {
      const shortUrl = "https://ssapi.shipstation.com/shipments?batchId=12345";
      const shortInput = buildShipStationWebhookInboxInput(
        makeReq({ "user-agent": "ShipStation" }),
        shortUrl,
        { resource_type: "SHIP_NOTIFY", resource_url: shortUrl },
      );

      expect(shortInput.provider).toBe("shipstation");
      expect(shortInput.topic).toBe("SHIP_NOTIFY");
      expect(shortInput.eventId).toBe(shortUrl);
      expect(shortInput.sourceDomain).toBe("ssapi.shipstation.com");
      expect(shortInput.idempotencyKey).toMatch(
        /^shipstation:SHIP_NOTIFY:[0-9a-f]{64}$/,
      );

      const longUrl = `https://ssapi.shipstation.com/shipments?${"x=".repeat(120)}`;
      const longInput = buildShipStationWebhookInboxInput(
        makeReq({}),
        longUrl,
        { resource_type: "SHIP_NOTIFY", resource_url: longUrl },
      );

      expect(longInput.eventId).toMatch(/^url:[0-9a-f]{64}$/);
      expect(longInput.eventId.length).toBeLessThanOrEqual(200);
      expect(longInput.idempotencyKey.length).toBeLessThanOrEqual(300);
    });

    it("hashes mutable Shopify products/update fallback eventIds when x-shopify-webhook-id is absent", () => {
      const first = buildShopifyWebhookInboxInput(
        makeReq({ "x-shopify-shop-domain": "cardshellz.myshopify.com" }),
        "products/update",
        { id: 8801, title: "Sleeves v1", variants: [{ sku: "SLV-1" }] },
      );
      const second = buildShopifyWebhookInboxInput(
        makeReq({ "x-shopify-shop-domain": "cardshellz.myshopify.com" }),
        "products/update",
        { id: 8801, title: "Sleeves v2", variants: [{ sku: "SLV-1" }] },
      );

      expect(first.eventId).toMatch(/^8801:payload:[0-9a-f]{64}$/);
      expect(second.eventId).toMatch(/^8801:payload:[0-9a-f]{64}$/);
      expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    });

    it("supports manual inbox replay for failed ShipStation SHIP_NOTIFY and Shopify products/update rows", async () => {
      for (const [provider, topic, payload] of [
        [
          "shipstation",
          "SHIP_NOTIFY",
          { resource_type: "SHIP_NOTIFY", resource_url: "https://ssapi.shipstation.com/shipments?batchId=9" },
        ],
        [
          "shopify",
          "products/update",
          { id: 8801, title: "Sleeves" },
        ],
      ] as const) {
        const execute = vi
          .fn()
          .mockResolvedValueOnce({
            rows: [{ id: 55, provider, topic, payload, status: "failed" }],
          })
          .mockResolvedValueOnce({ rows: [{ id: 91 }] })
          .mockResolvedValueOnce({ rows: [] });

        const replay = await enqueueWebhookInboxReplay(
          { execute },
          55,
          "ops@cardshellz.com",
        );

        expect(replay).toEqual({
          inboxId: 55,
          retryQueueId: 91,
          provider,
          topic,
          previousStatus: "failed",
        });
      }
    });

    it("links sourceInboxId and lastError onto ShipStation SHIP_NOTIFY retry rows when provided", async () => {
      const inserted: any[] = [];
      const db = {
        execute: vi.fn(async () => ({ rows: [] })),
        insert: vi.fn(() => ({
          values: vi.fn(async (row: any) => {
            inserted.push(row);
          }),
        })),
      };

      await enqueueShipStationRetry(
        db,
        { resource_url: "https://ssapi.shipstation.com/shipments?batchId=77" },
        { sourceInboxId: 333, lastError: "timeout" },
      );

      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        provider: "shipstation",
        topic: "SHIP_NOTIFY",
        payload: { resource_url: "https://ssapi.shipstation.com/shipments?batchId=77" },
        sourceInboxId: 333,
        lastError: "timeout",
        status: "pending",
        attempts: 0,
      });
    });

    it("enforces persist-to-inbox -> ACK -> process-from-inbox on SHIP_NOTIFY, products/*, and fulfillments/*", () => {
      const serverIndexSrc = readRepoFile("server/index.ts");
      const shipNotifyStart = serverIndexSrc.indexOf(
        'app.post("/api/shipstation/webhooks/ship-notify"',
      );
      const shipNotifyBlock = serverIndexSrc.slice(
        shipNotifyStart,
        shipNotifyStart + 3400,
      );

      const recordPos = shipNotifyBlock.indexOf("recordWebhookReceived(");
      const ackPos = shipNotifyBlock.indexOf('res.status(200).json({ status: "accepted"');
      const processPos = shipNotifyBlock.indexOf(
        "services.shippingEngine.processWebhook(resource_url)",
      );
      expect(recordPos).toBeGreaterThan(-1);
      expect(ackPos).toBeGreaterThan(recordPos);
      expect(processPos).toBeGreaterThan(ackPos);
      expect(shipNotifyBlock).toContain("sourceInboxId: inboxReceiptId");

      const shopifyRoutesSrc = readRepoFile("server/routes/shopify.routes.ts");
      expect(shopifyRoutesSrc).not.toContain("setImmediate(");
      expect(shopifyRoutesSrc).toContain("receiveShopifyRouteWebhook(");
      expect(shopifyRoutesSrc).toContain("acknowledgeShopifyRouteWebhookAccepted(");
      expect(shopifyRoutesSrc).toContain(
        'processDurableShopifyProductWebhook(req, res, "products/update"',
      );
      expect(shopifyRoutesSrc).toContain(
        'receiveShopifyRouteWebhook(inboxDb, req, res, "fulfillments/create", payload)',
      );
      expect(shopifyRoutesSrc).toContain(
        'receiveShopifyRouteWebhook(inboxDb, req, res, "fulfillments/update", payload)',
      );

      const workerSrc = readRepoFile("server/modules/oms/application/webhook-retry.worker.ts");
      expect(workerSrc).toContain('"products/update"');
      expect(workerSrc).toContain("SHOPIFY_ROUTE_TOPICS");
    });
  });
});
