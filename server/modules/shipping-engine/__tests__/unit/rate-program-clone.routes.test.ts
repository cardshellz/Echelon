import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerRateProgramCloneRoutes } from "../../interfaces/http/rate-program-clone.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("rate program clone routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let command: ReturnType<typeof fakeCommand>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    command = fakeCommand();
    server = await startServer(buildApp(command));
  });

  afterEach(async () => server.close());

  it("forwards an authenticated idempotent copy command", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-books/20/copy-rates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "copy-rates-test-0001",
        },
        body: JSON.stringify({ sourceRateBookId: 10 }),
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers["idempotency-replayed"]).toBe("false");
    expect(response.body).toMatchObject({
      sourceRateBook: { id: 10 },
      targetRateBook: { id: 20 },
      assignmentsCopied: false,
      liveRatesChanged: false,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("settings", "edit");
    expect(command.execute).toHaveBeenCalledTimes(1);
    const [input, descriptor] = command.execute.mock.calls[0]!;
    expect(input).toEqual({
      sourceRateBookId: 10,
      targetRateBookId: 20,
      actor: "operator-1",
    });
    expect(descriptor).toMatchObject({
      actorId: "operator-1",
      method: "POST",
      routeTemplate:
        "/api/shipping/admin/rate-books/:targetRateBookId/copy-rates",
      resourceKey: "shipping_rate_book:20",
      idempotencyKey: "copy-rates-test-0001",
      commandName: "shipping.rate_program.copy_rates",
    });
    expect(descriptor.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a missing idempotency key before calling the command", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-books/20/copy-rates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRateBookId: 10 }),
      },
    );

    expect(response).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED",
        },
      },
    });
    expect(command.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields at the HTTP boundary", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-books/20/copy-rates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "copy-rates-test-0002",
        },
        body: JSON.stringify({
          sourceRateBookId: 10,
          copyAssignments: true,
        }),
      },
    );

    expect(response).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "SHIPPING_ADMIN_COPY_INPUT_INVALID",
        },
      },
    });
    expect(command.execute).not.toHaveBeenCalled();
  });

  it("returns the durable replay marker from a stored result", async () => {
    command.execute.mockResolvedValue({
      commandId: 9,
      replayed: true,
      httpStatus: 201,
      terminalState: "succeeded",
      body: {
        sourceRateBook: { id: 10, name: "Source" },
        targetRateBook: { id: 20, name: "Target" },
        createdDrafts: [],
        assignmentsCopied: false,
        liveRatesChanged: false,
      },
    });
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-books/20/copy-rates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "copy-rates-test-0003",
        },
        body: JSON.stringify({ sourceRateBookId: 10 }),
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers["idempotency-replayed"]).toBe("true");
  });
});

function fakeCommand() {
  return {
    execute: vi.fn(async () => ({
      commandId: 8,
      replayed: false,
      httpStatus: 201,
      terminalState: "succeeded" as const,
      body: {
        sourceRateBook: { id: 10, name: "Source" },
        targetRateBook: { id: 20, name: "Target" },
        createdDrafts: [{
          id: 201,
          sourceRateTableId: 101,
          serviceLevelId: 1,
          serviceLevelCode: "standard",
          serviceLevelName: "Standard Shipping",
          rowCount: 12,
          coverageCount: 3,
        }],
        assignmentsCopied: false as const,
        liveRatesChanged: false as const,
      },
    })),
  };
}

function buildApp(command: ReturnType<typeof fakeCommand>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "session", {
      configurable: true,
      value: { user: { id: "operator-1" } },
    });
    next();
  });
  registerRateProgramCloneRoutes(app, { command });
  return app;
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: init.method,
      headers: init.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === ""
            ? {}
            : JSON.parse(rawBody) as Record<string, unknown>,
          headers: response.headers,
        });
      });
    });
    request.on("error", reject);
    request.write(init.body);
    request.end();
  });
}
