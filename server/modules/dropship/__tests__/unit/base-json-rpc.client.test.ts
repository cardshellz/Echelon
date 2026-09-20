import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USDC_RPC_TIMEOUT_MS,
  DROPSHIP_USDC_RPC_MISCONFIGURED,
  DROPSHIP_USDC_RPC_REJECTED,
  DROPSHIP_USDC_RPC_RESPONSE_INVALID,
  DROPSHIP_USDC_RPC_TRANSPORT_FAILED,
  FetchEvmJsonRpcClient,
  USDC_RPC_TIMEOUT_ENV,
  USDC_RPC_URL_ENV,
  createBaseJsonRpcClientFromEnv,
} from "../../infrastructure/base-json-rpc.client";
import { ERC20_TRANSFER_TOPIC } from "../../domain/usdc-deposits";

const URL = "https://rpc.example.test/base";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

type Handler = (method: string, params: unknown[], id: number) => unknown;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake node: answers each method from the handler, echoing the request id. */
function fakeFetch(handler: Handler) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method: request.method, params: request.params });
    const result = handler(request.method, request.params, request.id);
    if (result instanceof Response) return result;
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function makeClient(handler: Handler, timeoutMs = 1_000) {
  const { fetchImpl, calls } = fakeFetch(handler);
  return { client: new FetchEvmJsonRpcClient({ url: URL, fetch: fetchImpl, timeoutMs }), calls, fetchImpl };
}

describe("FetchEvmJsonRpcClient (funding design phase 6)", () => {
  it("reads the chain id and the head block number as integers", async () => {
    const { client, fetchImpl } = makeClient((method) => (method === "eth_chainId" ? "0x2105" : "0x2160ec0"));
    expect(await client.chainId()).toBe(8453);
    expect(await client.blockNumber()).toBe(35_000_000);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  });

  it("reads block headers by number and by tag, and reports a missing block as null", async () => {
    const { client, calls } = makeClient((method, params) => {
      if (method !== "eth_getBlockByNumber") throw new Error("unexpected");
      if (params[0] === "0x2160ec0" || params[0] === "safe") return { number: "0x2160ec0", hash: BLOCK_HASH.toUpperCase().replace("0X", "0x"), timestamp: "0x66d0a1b0", extra: true };
      return null;
    });
    expect(await client.getBlock(35_000_000)).toEqual({ number: 35_000_000, hash: BLOCK_HASH, timestamp: 1_724_948_912 });
    expect(await client.getBlock("safe")).toEqual({ number: 35_000_000, hash: BLOCK_HASH, timestamp: 1_724_948_912 });
    expect(await client.getBlock("finalized")).toBeNull();
    expect(calls.map((call) => call.params)).toEqual([["0x2160ec0", false], ["safe", false], ["finalized", false]]);
  });

  it("asks for logs with the block range as hex quantities and returns them validated", async () => {
    const log = { address: USDC, topics: [ERC20_TRANSFER_TOPIC, `0x${"0".repeat(64)}`, `0x${"1".repeat(64)}`], data: `0x${"0".repeat(64)}`, blockNumber: "0x10", blockHash: BLOCK_HASH, transactionHash: HASH, logIndex: "0x2" };
    const { client, calls } = makeClient(() => [log]);
    const logs = await client.getLogs({ fromBlock: 16, toBlock: 32, address: USDC, topics: [ERC20_TRANSFER_TOPIC, null, [`0x${"1".repeat(64)}`]] });
    expect(logs).toEqual([log]);
    expect(calls[0]).toEqual({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x10", toBlock: "0x20", address: USDC, topics: [ERC20_TRANSFER_TOPIC, null, [`0x${"1".repeat(64)}`]] }],
    });
    await expect(client.getLogs({ fromBlock: 33, toBlock: 32, address: USDC, topics: [] }))
      .rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_REJECTED, context: { classification: "permanent" } });
  });

  it("reads a receipt with its success flag and logs, and null for an unknown transaction", async () => {
    const { client } = makeClient((method, params) => {
      if (method !== "eth_getTransactionReceipt") throw new Error("unexpected");
      if (params[0] === HASH) return { transactionHash: HASH, blockNumber: "0x10", blockHash: BLOCK_HASH, status: "0x1", logs: [], gasUsed: "0x5208" };
      if (params[0] === `0x${"ef".repeat(32)}`) return { transactionHash: `0x${"ef".repeat(32)}`, blockNumber: "0x10", blockHash: BLOCK_HASH, status: "0x0", logs: [] };
      return null;
    });
    expect(await client.getTransactionReceipt(HASH)).toEqual({ transactionHash: HASH, blockNumber: 16, blockHash: BLOCK_HASH, succeeded: true, logs: [] });
    expect((await client.getTransactionReceipt(`0x${"ef".repeat(32)}`))?.succeeded).toBe(false);
    expect(await client.getTransactionReceipt(`0x${"00".repeat(32)}`)).toBeNull();
    await expect(client.getTransactionReceipt("0x1234")).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_REJECTED });
  });

  it("issues eth_call against the latest block by default and returns the raw bytes", async () => {
    const { client, calls } = makeClient(() => `0x${"0".repeat(63)}6`);
    expect(await client.call({ to: USDC, data: "0x313ce567" })).toBe(`0x${"0".repeat(63)}6`);
    expect(calls[0]).toEqual({ method: "eth_call", params: [{ to: USDC, data: "0x313ce567" }, "latest"] });
    await client.call({ to: USDC, data: "0x313ce567" }, "safe");
    expect(calls[1]?.params[1]).toBe("safe");
  });

  it("classifies a network failure and a non-2xx answer as transient", async () => {
    const failing = new FetchEvmJsonRpcClient({ url: URL, fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch, timeoutMs: 1_000 });
    await expect(failing.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_TRANSPORT_FAILED, context: { classification: "transient", timedOut: false } });
    const { client } = makeClient(() => jsonResponse({ error: "rate limited" }, 429));
    await expect(client.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_TRANSPORT_FAILED, context: { classification: "transient", httpStatus: 429 } });
  });

  it("times out a node that never answers, as a transient failure", async () => {
    const neverAnswers = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const client = new FetchEvmJsonRpcClient({ url: URL, fetch: neverAnswers, timeoutMs: 20 });
    await expect(client.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_TRANSPORT_FAILED, context: { classification: "transient", timedOut: true } });
  });

  it("classifies JSON-RPC errors: a bad request is permanent, a node fault is transient", async () => {
    const { client: badRequest } = makeClient((_method, _params, id) => jsonResponse({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } }));
    await expect(badRequest.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_REJECTED, context: { classification: "permanent", rpcCode: -32602 } });
    const { client: nodeFault } = makeClient((_method, _params, id) => jsonResponse({ jsonrpc: "2.0", id, error: { code: -32005, message: "limit exceeded", data: { retryAfter: 1 } } }));
    await expect(nodeFault.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_REJECTED, context: { classification: "transient", rpcCode: -32005, rpcData: { retryAfter: 1 } } });
  });

  it("refuses answers it cannot trust: not JSON, wrong envelope, another request's id, wrong shape, no result", async () => {
    const { client: notJson } = makeClient(() => new Response("<html>", { status: 200 }));
    await expect(notJson.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID, context: { classification: "permanent" } });
    const { client: wrongEnvelope } = makeClient(() => jsonResponse({ result: "0x1" }));
    await expect(wrongEnvelope.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID });
    const { client: wrongId } = makeClient((_method, _params, id) => jsonResponse({ jsonrpc: "2.0", id: id + 100, result: "0x1" }));
    await expect(wrongId.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID, context: { expectedId: 1, receivedId: 101 } });
    const { client: wrongShape } = makeClient(() => "not-hex");
    await expect(wrongShape.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID });
    const { client: noResult } = makeClient((_method, _params, id) => jsonResponse({ jsonrpc: "2.0", id }));
    await expect(noResult.blockNumber()).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID });
    const { client: badLog } = makeClient(() => [{ address: USDC, topics: ["0x12"], data: "0x", blockNumber: "0x1", blockHash: BLOCK_HASH, transactionHash: HASH, logIndex: "0x0" }]);
    await expect(badLog.getLogs({ fromBlock: 1, toBlock: 2, address: USDC, topics: [] })).rejects.toMatchObject({ code: DROPSHIP_USDC_RPC_RESPONSE_INVALID });
  });

  it("refuses an unusable timeout at construction", () => {
    for (const timeoutMs of [0, -1, 1.5, 120_001]) {
      expect(() => new FetchEvmJsonRpcClient({ url: URL, fetch: fetch, timeoutMs }))
        .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_RPC_MISCONFIGURED }));
    }
  });
});

describe("createBaseJsonRpcClientFromEnv", () => {
  it("watches nothing without a URL, and builds a client with the default timeout from one", () => {
    expect(createBaseJsonRpcClientFromEnv({})).toBeNull();
    expect(createBaseJsonRpcClientFromEnv({ [USDC_RPC_URL_ENV]: "  " })).toBeNull();
    const client = createBaseJsonRpcClientFromEnv({ [USDC_RPC_URL_ENV]: ` ${URL} ` }, fetch);
    expect(client).toBeInstanceOf(FetchEvmJsonRpcClient);
    expect(DEFAULT_USDC_RPC_TIMEOUT_MS).toBe(10_000);
  });

  it("refuses a URL that is not https or cannot be parsed, and a timeout it cannot use", () => {
    expect(() => createBaseJsonRpcClientFromEnv({ [USDC_RPC_URL_ENV]: "http://rpc.example.test" }))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_RPC_MISCONFIGURED, context: expect.objectContaining({ protocol: "http:" }) }));
    expect(() => createBaseJsonRpcClientFromEnv({ [USDC_RPC_URL_ENV]: "not a url" }))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_RPC_MISCONFIGURED }));
    expect(() => createBaseJsonRpcClientFromEnv({ [USDC_RPC_URL_ENV]: URL, [USDC_RPC_TIMEOUT_ENV]: "soon" }))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_RPC_MISCONFIGURED }));
  });
});
