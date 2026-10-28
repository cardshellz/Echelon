import { describe, expect, it } from "vitest";
import {
  DATABASE_SOCKET_ERROR_CODES,
  DATABASE_UNAVAILABLE_SQLSTATES,
  isDatabaseUnavailableError,
} from "../../infrastructure/database-unavailable-error";
import * as dropshipReExport from "../../modules/dropship/domain/database-unavailable-error";

// Channels PR2 (PLAN-CH2 v4.1 §4.1, SAF-4): the predicate moved from Dropship's domain to server/infrastructure so
// inventory planning's stock-link engine can share it; Dropship's file re-exports it unchanged.

describe("isDatabaseUnavailableError (shared)", () => {
  it("is true for an unavailable server, a lost socket and node-postgres's connection messages", () => {
    for (const code of [...DATABASE_UNAVAILABLE_SQLSTATES, ...DATABASE_SOCKET_ERROR_CODES, "08000", "08006", "08P01"]) {
      expect(isDatabaseUnavailableError(Object.assign(new Error("x"), { code })), code).toBe(true);
    }
    for (const message of ["timeout exceeded when trying to connect", "Connection terminated unexpectedly",
      "Connection terminated due to connection timeout", "Client has encountered a connection error and is not queryable"]) {
      expect(isDatabaseUnavailableError(new Error(message)), message).toBe(true);
    }
  });

  it("is false for statement errors and non-errors", () => {
    for (const error of [Object.assign(new Error("x"), { code: "40001" }), Object.assign(new Error("x"), { code: "57014" }),
      Object.assign(new Error("x"), { code: "23514" }), new Error("boom"), null, undefined, "Connection terminated", 42]) {
      expect(isDatabaseUnavailableError(error)).toBe(false);
    }
  });

  it("Dropship's domain file re-exports the same bindings", () => {
    expect(dropshipReExport.isDatabaseUnavailableError).toBe(isDatabaseUnavailableError);
    expect(dropshipReExport.DATABASE_SOCKET_ERROR_CODES).toBe(DATABASE_SOCKET_ERROR_CODES);
    expect(dropshipReExport.DATABASE_UNAVAILABLE_SQLSTATES).toBe(DATABASE_UNAVAILABLE_SQLSTATES);
  });
});
