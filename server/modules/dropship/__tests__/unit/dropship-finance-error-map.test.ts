import { describe, expect, it, vi } from "vitest";
import { financeErrorCodeSchema } from "../../../../../shared/dropship/program-finance";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/dropship-finance.factory", () => ({ createDropshipFinanceServiceFromEnv: () => ({}) }));

import {
  FINANCE_CLASSIFIED_CODES,
  FINANCE_INTERNAL_ERROR_CODE,
  FINANCE_INVALID_INPUT_CODE,
  FINANCE_VENDOR_NOT_FOUND_CODE,
  financeErrorClassification,
} from "../../application/dropship-finance-service";
import { FINANCE_INVALID_PERIOD_CODE } from "../../domain/program-finance-period";
import {
  FINANCE_AMOUNT_OUT_OF_RANGE_SQL_CODE,
  FINANCE_BUDGET_EXCEEDED_CODE,
  FINANCE_DATA_INVALID_SQL_CODE,
  FINANCE_DB_UNAVAILABLE_CODE,
  FINANCE_INTERNAL_ERROR_SQL_CODE,
  FINANCE_QUERY_TIMEOUT_CODE,
  FINANCE_SCHEMA_MISMATCH_CODE,
  FINANCE_TABLE_MISSING_SQL_CODE,
} from "../../infrastructure/dropship-finance-read-transaction";
import { FINANCE_BUSY_CODE } from "../../infrastructure/dropship-finance.repository";
import { FINANCE_ERROR_CODES, classifyFinanceError } from "../../interfaces/http/dropship-admin-finance.routes";

/** Contract §5, row by row. */
const EXPECTED: readonly [string, number, "transient" | "permanent" | "fatal"][] = [
  ["DROPSHIP_FINANCE_INVALID_INPUT", 400, "permanent"],
  ["DROPSHIP_FINANCE_INVALID_PERIOD", 400, "permanent"],
  ["DROPSHIP_FINANCE_INVALID_CURSOR", 400, "permanent"],
  ["DROPSHIP_FINANCE_ORDER_NOT_FOUND", 404, "permanent"],
  ["DROPSHIP_FINANCE_VENDOR_NOT_FOUND", 404, "permanent"],
  ["DROPSHIP_FINANCE_EXPORT_TOO_LARGE", 400, "permanent"],
  ["DROPSHIP_FINANCE_ORDER_TOO_LARGE", 422, "permanent"],
  ["DROPSHIP_FINANCE_BUSY", 503, "transient"],
  ["DROPSHIP_FINANCE_QUERY_TIMEOUT", 503, "transient"],
  ["DROPSHIP_FINANCE_DB_UNAVAILABLE", 503, "transient"],
  ["DROPSHIP_FINANCE_TABLE_MISSING", 503, "transient"],
  ["DROPSHIP_FINANCE_BUDGET_EXCEEDED", 503, "transient"],
  ["DROPSHIP_FINANCE_SCHEMA_MISMATCH", 500, "fatal"],
  ["DROPSHIP_FINANCE_DATA_INVALID", 500, "permanent"],
  ["DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE", 500, "fatal"],
  ["DROPSHIP_FINANCE_CONTRACT_VIOLATION", 500, "fatal"],
  ["DROPSHIP_FINANCE_INTERNAL_ERROR", 500, "fatal"],
];

describe("classifyFinanceError (contract §5)", () => {
  it.each(EXPECTED)("%s → %i %s", (code, status, classification) => {
    expect(classifyFinanceError(code)).toEqual({ status, classification });
  });

  it("knows exactly the contract's codes, each a valid envelope code", () => {
    expect([...FINANCE_ERROR_CODES].sort()).toEqual(EXPECTED.map(([code]) => code).sort());
    for (const code of FINANCE_ERROR_CODES) expect(financeErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it("treats a code it does not know as a fatal internal error", () => {
    expect(classifyFinanceError("DROPSHIP_FINANCE_SOMETHING_NEW")).toEqual({ status: 500, classification: "fatal" });
    expect(classifyFinanceError("DROPSHIP_WALLET_ACCOUNT_NOT_FOUND")).toEqual({ status: 500, classification: "fatal" });
  });

  it("classifies every code the finance modules raise", () => {
    const raised = [
      FINANCE_INVALID_INPUT_CODE, FINANCE_VENDOR_NOT_FOUND_CODE, FINANCE_INVALID_PERIOD_CODE, FINANCE_BUSY_CODE,
      FINANCE_QUERY_TIMEOUT_CODE, FINANCE_DB_UNAVAILABLE_CODE, FINANCE_TABLE_MISSING_SQL_CODE, FINANCE_SCHEMA_MISMATCH_CODE,
      FINANCE_DATA_INVALID_SQL_CODE, FINANCE_AMOUNT_OUT_OF_RANGE_SQL_CODE, FINANCE_INTERNAL_ERROR_SQL_CODE, FINANCE_BUDGET_EXCEEDED_CODE,
      FINANCE_INTERNAL_ERROR_CODE,
    ];
    for (const code of raised) expect(FINANCE_ERROR_CODES).toContain(code);
  });

  it("takes every class from the one code → class map the service logs with", () => {
    // The route's status map and the application's class map name the same codes.
    expect([...FINANCE_CLASSIFIED_CODES].sort()).toEqual([...FINANCE_ERROR_CODES].sort());
    for (const [code, , classification] of EXPECTED) {
      expect([code, financeErrorClassification(code)]).toEqual([code, classification]);
      expect(classifyFinanceError(code).classification).toBe(financeErrorClassification(code));
    }
    expect(financeErrorClassification("DROPSHIP_FINANCE_SOMETHING_NEW")).toBe("fatal");
    expect(financeErrorClassification(undefined)).toBe("fatal");
  });
});
