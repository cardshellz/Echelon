import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { relationshipFixture } from "../../../../../test/fixtures/document-relationships";
import { registerDocumentRelationshipRoutes } from "../../document-relationships.routes";
import { createDocumentRelationshipService } from "../../document-relationships.service";

vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) =>
  (req: Request, res: Response, next: NextFunction) => req.headers["x-permission"] === `${resource}:${action}` ? next() : res.sendStatus(403) }));

describe("document relationship read boundary", () => {
  let server: Server; let url: string;
  const repository = { read: vi.fn() };
  beforeEach(async () => {
    repository.read.mockReset().mockImplementation(async root => relationshipFixture(root));
    const app = express(); registerDocumentRelationshipRoutes(app, createDocumentRelationshipService(repository));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/procurement/relationships`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  const permitted = { headers: { "x-permission": "purchasing:view" } };
  it("requires view access before reading any relationships", async () => {
    expect((await fetch(`${url}/shipment/42`)).status).toBe(403); expect(repository.read).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "42x", "42.5", "0042", "2147483648"])("rejects malformed identifier %s", async id => {
    expect((await fetch(`${url}/shipment/${id}`, permitted)).status).toBe(400); expect(repository.read).not.toHaveBeenCalled();
  });
  it.each(["purchase", "shipment", "receipt"])("reads and validates the %s projection", async kind => {
    const response = await fetch(`${url}/${kind}/42`, permitted); expect(response.status).toBe(200);
    expect((await response.json()).root).toEqual({ kind, id: 42 });
  });
  it("distinguishes missing records from failed reads without leaking internals", async () => {
    repository.read.mockResolvedValueOnce(null);
    expect((await fetch(`${url}/shipment/42`, permitted)).status).toBe(404);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.read.mockRejectedValueOnce(new Error("secret database details"));
    const failure = await fetch(`${url}/shipment/42`, permitted);
    expect(failure.status).toBe(500); expect(await failure.text()).not.toContain("secret");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("procurement.relationships.read_failed"));
  });
  it("fails closed on a wrong root or duplicate monetary identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.read.mockResolvedValueOnce(relationshipFixture({ kind: "shipment", id: 43 }));
    expect((await fetch(`${url}/shipment/42`, permitted)).status).toBe(500);
    const duplicate = relationshipFixture(); duplicate.allocations.push(duplicate.allocations[0]); repository.read.mockResolvedValueOnce(duplicate);
    expect((await fetch(`${url}/shipment/42`, permitted)).status).toBe(500);
  });
});
