import { describe, expect, it } from "vitest";

import {
  financialCommandFromRequest,
  hashHttpFinancialCommand,
} from "../../commands/http-command";
import { FinancialCommandError } from "../../commands/transactional-command.service";

function request(overrides: Record<string, unknown> = {}): any {
  return {
    method: "POST",
    headers: { "idempotency-key": "po-line-command-123" },
    params: { id: "41" },
    query: {},
    body: { b: 2, a: 1 },
    session: { user: { id: "user-7" } },
    ...overrides,
  };
}

const options = {
  routeTemplate: "/api/purchase-orders/:id/lines",
  resourceKey: "purchase_order:41",
  commandName: "purchase_order.line.add",
} as const;

describe("financialCommandFromRequest", () => {
  it("scopes and hashes the complete command identity", () => {
    const descriptor = financialCommandFromRequest(request(), options);
    expect(descriptor).toMatchObject({
      actorType: "user",
      actorId: "user-7",
      method: "POST",
      routeTemplate: options.routeTemplate,
      resourceKey: options.resourceKey,
      idempotencyKey: "po-line-command-123",
      commandName: options.commandName,
      contractVersion: 1,
    });
    expect(descriptor.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable across object key order but sensitive to array order", () => {
    const first = hashHttpFinancialCommand({
      method: "POST",
      ...options,
      body: { a: 1, nested: { z: 2, b: 3 }, values: [1, 2] },
    });
    const reordered = hashHttpFinancialCommand({
      method: "POST",
      ...options,
      body: { values: [1, 2], nested: { b: 3, z: 2 }, a: 1 },
    });
    const different = hashHttpFinancialCommand({
      method: "POST",
      ...options,
      body: { a: 1, nested: { z: 2, b: 3 }, values: [2, 1] },
    });
    expect(reordered).toBe(first);
    expect(different).not.toBe(first);
  });

  it("requires a valid key and authenticated actor", () => {
    expect(() => financialCommandFromRequest(request({ headers: {} }), options)).toThrowError(
      expect.objectContaining<Partial<FinancialCommandError>>({
        code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED",
        statusCode: 400,
      }),
    );
    expect(() => financialCommandFromRequest(request({ session: undefined }), options)).toThrowError(
      expect.objectContaining<Partial<FinancialCommandError>>({
        code: "FINANCIAL_COMMAND_ACTOR_REQUIRED",
        statusCode: 401,
      }),
    );
  });

  it("rejects conflicting standard and legacy idempotency headers", () => {
    expect(() => financialCommandFromRequest(request({
      headers: {
        "idempotency-key": "po-line-command-123",
        "x-idempotency-key": "po-line-command-456",
      },
    }), options)).toThrowError(
      expect.objectContaining<Partial<FinancialCommandError>>({
        code: "FINANCIAL_COMMAND_IDEMPOTENCY_HEADERS_CONFLICT",
        statusCode: 400,
      }),
    );
  });

  it("changes the hash with HTTP request identity but not internal command renames", () => {
    const base = financialCommandFromRequest(request(), options).requestHash;
    expect(financialCommandFromRequest(request(), {
      ...options,
      resourceKey: "purchase_order:42",
    }).requestHash).not.toBe(base);
    expect(financialCommandFromRequest(request({ params: { id: "42" } }), options).requestHash).not.toBe(base);
    expect(financialCommandFromRequest(request(), {
      ...options,
      commandName: "purchase_order.line.bulk_add",
    }).requestHash).toBe(base);
  });
});
