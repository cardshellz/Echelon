/**
 * JSON-RPC client for the Base chain (funding design phase 6).
 *
 * The USDC watcher needs five reads: the chain id, block headers by number
 * or tag (`latest`, `safe`, `finalized`), `Transfer` logs of the USDC
 * contract over a block range, a transaction receipt, and `eth_call` for
 * balance and token checks. Nothing is written to the chain: the server holds
 * no key that could.
 *
 * Every response is validated with a schema before it is trusted, and every
 * failure is classified: a network or node fault is transient (the next tick
 * retries), a malformed answer or a rejected request is permanent (a human
 * looks). The transport is the platform `fetch`, injected for tests.
 */

import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { DropshipError } from "../domain/errors";
import {
  EVM_ADDRESS_PATTERN,
  EVM_BYTES_PATTERN,
  EVM_QUANTITY_PATTERN,
  EVM_WORD_PATTERN,
  hexQuantityToBigInt,
  hexQuantityToSafeInteger,
  integerToHexQuantity,
} from "../domain/evm-abi";
import { ERC20_TRANSFER_EVENT_SIGNATURE, ERC20_TRANSFER_TOPIC } from "../domain/usdc-deposits";
import type { DropshipLogger } from "../application/dropship-ports";

export const DROPSHIP_USDC_RPC_MISCONFIGURED = "DROPSHIP_USDC_RPC_MISCONFIGURED";
export const DROPSHIP_USDC_RPC_TRANSPORT_FAILED = "DROPSHIP_USDC_RPC_TRANSPORT_FAILED";
export const DROPSHIP_USDC_RPC_RESPONSE_INVALID = "DROPSHIP_USDC_RPC_RESPONSE_INVALID";
export const DROPSHIP_USDC_RPC_REJECTED = "DROPSHIP_USDC_RPC_REJECTED";

export const USDC_RPC_URL_ENV = "DROPSHIP_USDC_BASE_RPC_URL";
export const USDC_RPC_TIMEOUT_ENV = "DROPSHIP_USDC_RPC_TIMEOUT_MS";
export const DEFAULT_USDC_RPC_TIMEOUT_MS = 10_000;
const MAX_USDC_RPC_TIMEOUT_MS = 120_000;

/** JSON-RPC 2.0 errors that mean the request itself is wrong; every other code is the node's problem. */
const PERMANENT_JSON_RPC_ERROR_CODES = new Set([-32700, -32600, -32601, -32602]);

export type EvmBlockTag = "latest" | "safe" | "finalized";

export interface EvmBlockHeader {
  number: number;
  hash: string;
  /** Unix seconds, as the chain reports it. */
  timestamp: number;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface EvmTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  /** True when the transaction succeeded; a reverted transaction emits no logs. */
  succeeded: boolean;
  logs: EvmLog[];
}

export interface EvmLogFilter {
  address: string;
  topics: (string | string[] | null)[];
}

export interface EvmJsonRpcClient {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  getBlock(reference: number | EvmBlockTag): Promise<EvmBlockHeader | null>;
  getLogs(filter: EvmLogFilter & { fromBlock: number; toBlock: number }): Promise<EvmLog[]>;
  getTransactionReceipt(transactionHash: string): Promise<EvmTransactionReceipt | null>;
  call(input: { to: string; data: string }, block?: EvmBlockTag): Promise<string>;
}

const hexQuantitySchema = z.string().regex(EVM_QUANTITY_PATTERN);
const hexWordSchema = z.string().regex(EVM_WORD_PATTERN);
const hexBytesSchema = z.string().regex(EVM_BYTES_PATTERN);
const addressSchema = z.string().regex(EVM_ADDRESS_PATTERN);

const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});

const blockHeaderSchema = z.object({
  number: hexQuantitySchema,
  hash: hexWordSchema,
  timestamp: hexQuantitySchema,
}).passthrough();

const logSchema = z.object({
  address: addressSchema,
  topics: z.array(hexWordSchema),
  data: hexBytesSchema,
  blockNumber: hexQuantitySchema,
  blockHash: hexWordSchema,
  transactionHash: hexWordSchema,
  logIndex: hexQuantitySchema,
  removed: z.boolean().optional(),
}).passthrough();

const receiptSchema = z.object({
  transactionHash: hexWordSchema,
  blockNumber: hexQuantitySchema,
  blockHash: hexWordSchema,
  status: hexQuantitySchema.optional(),
  logs: z.array(logSchema),
}).passthrough();

export class FetchEvmJsonRpcClient implements EvmJsonRpcClient {
  private nextRequestId = 1;

  constructor(
    private readonly deps: {
      url: string;
      fetch: typeof fetch;
      timeoutMs: number;
      logger?: DropshipLogger;
    },
  ) {
    if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0 || deps.timeoutMs > MAX_USDC_RPC_TIMEOUT_MS) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_MISCONFIGURED,
        `The USDC RPC timeout must be a whole number of milliseconds from 1 to ${MAX_USDC_RPC_TIMEOUT_MS}.`,
        { env: USDC_RPC_TIMEOUT_ENV, value: deps.timeoutMs, classification: "fatal" },
      );
    }
    // The topic constant the watcher filters on is pinned in the domain; a
    // typo there would silently watch nothing, so it is checked once here.
    const computed = `0x${Array.from(keccak_256(new TextEncoder().encode(ERC20_TRANSFER_EVENT_SIGNATURE)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (computed !== ERC20_TRANSFER_TOPIC) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_MISCONFIGURED,
        "The pinned ERC-20 Transfer topic does not match keccak256 of the event signature.",
        { pinned: ERC20_TRANSFER_TOPIC, computed, classification: "fatal" },
      );
    }
  }

  async chainId(): Promise<number> {
    const result = await this.request("eth_chainId", []);
    return hexQuantityToSafeInteger(this.parse(hexQuantitySchema, result, "eth_chainId"), "chainId");
  }

  async blockNumber(): Promise<number> {
    const result = await this.request("eth_blockNumber", []);
    return hexQuantityToSafeInteger(this.parse(hexQuantitySchema, result, "eth_blockNumber"), "blockNumber");
  }

  async getBlock(reference: number | EvmBlockTag): Promise<EvmBlockHeader | null> {
    const parameter = typeof reference === "number" ? integerToHexQuantity(reference, "blockNumber") : reference;
    const result = await this.request("eth_getBlockByNumber", [parameter, false]);
    if (result === null) return null;
    const header = this.parse(blockHeaderSchema, result, "eth_getBlockByNumber");
    return {
      number: hexQuantityToSafeInteger(header.number, "block.number"),
      hash: header.hash.toLowerCase(),
      timestamp: hexQuantityToSafeInteger(header.timestamp, "block.timestamp"),
    };
  }

  async getLogs(filter: EvmLogFilter & { fromBlock: number; toBlock: number }): Promise<EvmLog[]> {
    if (filter.toBlock < filter.fromBlock) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_REJECTED,
        "A log range must not end before it starts.",
        { fromBlock: filter.fromBlock, toBlock: filter.toBlock, classification: "permanent" },
      );
    }
    const result = await this.request("eth_getLogs", [{
      fromBlock: integerToHexQuantity(filter.fromBlock, "fromBlock"),
      toBlock: integerToHexQuantity(filter.toBlock, "toBlock"),
      address: filter.address,
      topics: filter.topics,
    }]);
    return this.parse(z.array(logSchema), result, "eth_getLogs");
  }

  async getTransactionReceipt(transactionHash: string): Promise<EvmTransactionReceipt | null> {
    if (!EVM_WORD_PATTERN.test(transactionHash)) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_REJECTED,
        "A transaction hash must be a 32-byte hex word.",
        { transactionHash, classification: "permanent" },
      );
    }
    const result = await this.request("eth_getTransactionReceipt", [transactionHash]);
    if (result === null) return null;
    const receipt = this.parse(receiptSchema, result, "eth_getTransactionReceipt");
    return {
      transactionHash: receipt.transactionHash.toLowerCase(),
      blockNumber: hexQuantityToSafeInteger(receipt.blockNumber, "receipt.blockNumber"),
      blockHash: receipt.blockHash.toLowerCase(),
      // Pre-Byzantium receipts carry no status; Base never had them, so a
      // missing status is treated as failure rather than trusted.
      succeeded: receipt.status !== undefined && hexQuantityToBigInt(receipt.status, "receipt.status") === BigInt(1),
      logs: receipt.logs,
    };
  }

  async call(input: { to: string; data: string }, block: EvmBlockTag = "latest"): Promise<string> {
    const result = await this.request("eth_call", [{ to: input.to, data: input.data }, block]);
    return this.parse(hexBytesSchema, result, "eth_call");
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_RESPONSE_INVALID,
        `The node's ${method} answer did not have the expected shape.`,
        { method, issues: parsed.error.issues.slice(0, 5), classification: "permanent" },
      );
    }
    return parsed.data;
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    let response: Response;
    try {
      response = await this.deps.fetch(this.deps.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_TRANSPORT_FAILED,
        controller.signal.aborted
          ? `The node did not answer ${method} within ${this.deps.timeoutMs}ms.`
          : `The node could not be reached for ${method}.`,
        { method, timedOut: controller.signal.aborted, reason: error instanceof Error ? error.message : String(error), classification: "transient" },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_TRANSPORT_FAILED,
        `The node answered ${method} with HTTP ${response.status}.`,
        { method, httpStatus: response.status, classification: "transient" },
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_RESPONSE_INVALID,
        `The node's ${method} answer was not JSON.`,
        { method, reason: error instanceof Error ? error.message : String(error), classification: "permanent" },
      );
    }
    const envelope = this.parse(jsonRpcEnvelopeSchema, body, method);
    if (envelope.id !== id) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_RESPONSE_INVALID,
        `The node answered ${method} with another request's id.`,
        { method, expectedId: id, receivedId: envelope.id, classification: "permanent" },
      );
    }
    if (envelope.error) {
      const classification = PERMANENT_JSON_RPC_ERROR_CODES.has(envelope.error.code) ? "permanent" : "transient";
      throw new DropshipError(
        DROPSHIP_USDC_RPC_REJECTED,
        `The node rejected ${method}: ${envelope.error.message}`,
        { method, rpcCode: envelope.error.code, rpcData: envelope.error.data ?? null, classification },
      );
    }
    if (!("result" in envelope)) {
      throw new DropshipError(
        DROPSHIP_USDC_RPC_RESPONSE_INVALID,
        `The node's ${method} answer carried neither a result nor an error.`,
        { method, classification: "permanent" },
      );
    }
    return envelope.result ?? null;
  }
}

/**
 * The client the environment configures, or null when no RPC URL is set
 * (USDC deposits are then not watched). A URL that is not https is refused:
 * the answers decide money and must not travel in the clear.
 */
export function createBaseJsonRpcClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
  logger?: DropshipLogger,
): FetchEvmJsonRpcClient | null {
  const raw = env[USDC_RPC_URL_ENV];
  if (raw === undefined || !raw.trim()) return null;
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DropshipError(
      DROPSHIP_USDC_RPC_MISCONFIGURED,
      "The USDC RPC URL cannot be parsed.",
      { env: USDC_RPC_URL_ENV, classification: "fatal" },
    );
  }
  if (parsed.protocol !== "https:") {
    throw new DropshipError(
      DROPSHIP_USDC_RPC_MISCONFIGURED,
      "The USDC RPC URL must use https.",
      { env: USDC_RPC_URL_ENV, protocol: parsed.protocol, classification: "fatal" },
    );
  }
  const timeoutRaw = env[USDC_RPC_TIMEOUT_ENV];
  const timeoutMs = timeoutRaw === undefined || !timeoutRaw.trim()
    ? DEFAULT_USDC_RPC_TIMEOUT_MS
    : Number(timeoutRaw);
  return new FetchEvmJsonRpcClient({ url, fetch: fetchImpl, timeoutMs, logger });
}
