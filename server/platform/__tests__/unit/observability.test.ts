import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runWithContext,
  getContext,
  enrichContext,
  AppError,
  classify,
  logger,
  setLogLevel,
} from "../../observability";

describe("log-context :: AsyncLocalStorage", () => {
  it("runWithContext provides context inside the callback", () => {
    let captured: any;
    runWithContext({ correlationId: "abc-123", omsOrderId: 42 }, () => {
      captured = getContext();
    });
    expect(captured).toMatchObject({
      correlationId: "abc-123",
      omsOrderId: 42,
    });
  });

  it("generates a correlationId when not provided", () => {
    let captured: any;
    runWithContext({}, () => {
      captured = getContext();
    });
    expect(captured?.correlationId).toBeDefined();
    expect(typeof captured?.correlationId).toBe("string");
    expect(captured?.correlationId.length).toBeGreaterThan(0);
  });

  it("getContext returns undefined outside runWithContext", () => {
    expect(getContext()).toBeUndefined();
  });

  it("enrichContext adds fields to current context", () => {
    let captured: any;
    runWithContext({ correlationId: "x" }, () => {
      enrichContext({ wmsOrderId: 99, shipmentId: 501 });
      captured = getContext();
    });
    expect(captured).toMatchObject({
      correlationId: "x",
      wmsOrderId: 99,
      shipmentId: 501,
    });
  });
});

describe("errors :: AppError + classify", () => {
  it("AppError carries code, context, errorClass, httpStatus", () => {
    const err = new AppError({
      code: "ORDER.NOT_FOUND",
      message: "Order 123 not found",
      context: { orderId: 123 },
      errorClass: "permanent",
      httpStatus: 404,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ORDER.NOT_FOUND");
    expect(err.errorClass).toBe("permanent");
    expect(err.httpStatus).toBe(404);
    expect(err.context).toEqual({ orderId: 123 });
    expect(err.message).toBe("Order 123 not found");
  });

  it("defaults to transient / 500", () => {
    const err = new AppError({ code: "X", message: "boom" });
    expect(err.errorClass).toBe("transient");
    expect(err.httpStatus).toBe(500);
  });

  it("classify returns errorClass from AppError directly", () => {
    const err = new AppError({
      code: "X",
      message: "test",
      errorClass: "fatal",
    });
    expect(classify(err)).toBe("fatal");
  });

  it("classify detects permanent patterns", () => {
    expect(classify(new Error("already shipped — cannot cancel"))).toBe("permanent");
    expect(classify(new Error("unique constraint violation"))).toBe("permanent");
    expect(classify(new Error("duplicate key value"))).toBe("permanent");
    expect(classify(new Error("violates foreign key"))).toBe("permanent");
  });

  it("classify detects fatal codes", () => {
    const err: any = new Error("connection refused");
    err.code = "ECONNREFUSED";
    expect(classify(err)).toBe("fatal");
  });

  it("classify defaults to transient for unknown errors", () => {
    expect(classify(new Error("timeout"))).toBe("transient");
    expect(classify("some string error")).toBe("transient");
  });
});

describe("logger :: structured output", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogLevel("debug");
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setLogLevel("info");
  });

  it("info writes JSON to stdout", () => {
    logger.info("order.created", { outcome: "success", orderId: 42 });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(line.level).toBe("info");
    expect(line.action).toBe("order.created");
    expect(line.outcome).toBe("success");
    expect(line.ts).toBeDefined();
  });

  it("error writes JSON to stderr", () => {
    logger.error("db.query_failed", { error_code: "TIMEOUT" });
    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(line.level).toBe("error");
    expect(line.action).toBe("db.query_failed");
  });

  it("merges ALS context into log line", () => {
    runWithContext({ correlationId: "req-abc", omsOrderId: 7 }, () => {
      logger.info("test.action");
    });
    const line = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(line.correlationId).toBe("req-abc");
    expect(line.omsOrderId).toBe(7);
  });

  it("respects log level filtering", () => {
    setLogLevel("warn");
    logger.debug("should.skip");
    logger.info("should.skip");
    logger.warn("should.emit");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
