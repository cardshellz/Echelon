/**
 * EVM ABI helpers for the USDC watcher (funding design phase 6).
 *
 * Only what reading an ERC-20 needs: 32-byte words in and out of hex, the
 * three call selectors, and the topic form of an address. Pure and
 * dependency-free; every malformed input is refused with a permanent error,
 * because a value the chain did not produce must never become money.
 */

import { DropshipError } from "./errors";

export const DROPSHIP_EVM_ABI_INVALID = "DROPSHIP_EVM_ABI_INVALID";

/** The first four bytes of keccak256 of the function signature. */
export const ERC20_SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
} as const;

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** A 32-byte word: a topic, a transaction hash or a block hash. */
export const EVM_WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** A JSON-RPC quantity: hex with no fixed width. */
export const EVM_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;
/** Arbitrary bytes: hex of even length, possibly empty. */
export const EVM_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

const WORD_HEX_LENGTH = 64;
const ADDRESS_HEX_LENGTH = 40;
const TOPIC_ADDRESS_PADDING = "0".repeat(WORD_HEX_LENGTH - ADDRESS_HEX_LENGTH);
const MAX_UINT8 = BigInt(255);

export function normalizeEvmAddress(value: string, field = "address"): string {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value)) {
    throw invalid(field, value, "must be 0x followed by 40 hex characters");
  }
  return value.toLowerCase();
}

/** The 32-byte topic form of an address: 12 zero bytes then the address. */
export function addressToTopic(address: string): string {
  const normalized = normalizeEvmAddress(address);
  return `0x${TOPIC_ADDRESS_PADDING}${normalized.slice(2)}`;
}

/** The address inside an indexed-address topic; the 12 leading bytes must be zero. */
export function topicToAddress(topic: string, field = "topic"): string {
  if (typeof topic !== "string" || !EVM_WORD_PATTERN.test(topic)) {
    throw invalid(field, topic, "must be a 32-byte hex word");
  }
  const lower = topic.toLowerCase();
  if (!lower.startsWith(`0x${TOPIC_ADDRESS_PADDING}`)) {
    throw invalid(field, topic, "is not an address topic: the leading 12 bytes are not zero");
  }
  return `0x${lower.slice(2 + TOPIC_ADDRESS_PADDING.length)}`;
}

/** One unsigned 256-bit word. */
export function decodeUint256Word(word: string, field = "word"): bigint {
  if (typeof word !== "string" || !EVM_WORD_PATTERN.test(word)) {
    throw invalid(field, word, "must be a 32-byte hex word");
  }
  return BigInt(word);
}

export function decodeUint8Word(word: string, field = "word"): number {
  const value = decodeUint256Word(word, field);
  if (value > MAX_UINT8) {
    throw invalid(field, word, "does not fit in a uint8");
  }
  return Number(value);
}

/**
 * An ABI-encoded dynamic `string` return value: an offset word, a length
 * word, then the bytes padded to a word boundary.
 */
export function decodeAbiString(returnData: string, field = "returnData"): string {
  if (typeof returnData !== "string" || !EVM_BYTES_PATTERN.test(returnData)) {
    throw invalid(field, returnData, "must be hex bytes");
  }
  const hex = returnData.slice(2);
  if (hex.length < WORD_HEX_LENGTH * 2) {
    throw invalid(field, returnData, "is shorter than an offset and a length word");
  }
  const offsetBytes = BigInt(`0x${hex.slice(0, WORD_HEX_LENGTH)}`);
  const offsetHex = offsetBytes * BigInt(2);
  if (offsetHex + BigInt(WORD_HEX_LENGTH) > BigInt(hex.length)) {
    throw invalid(field, returnData, "points its string outside the return data");
  }
  const lengthStart = Number(offsetHex);
  const lengthBytes = BigInt(`0x${hex.slice(lengthStart, lengthStart + WORD_HEX_LENGTH)}`);
  const contentStart = lengthStart + WORD_HEX_LENGTH;
  const contentHexLength = lengthBytes * BigInt(2);
  if (BigInt(contentStart) + contentHexLength > BigInt(hex.length)) {
    throw invalid(field, returnData, "declares a string longer than the return data");
  }
  const contentHex = hex.slice(contentStart, contentStart + Number(contentHexLength));
  return new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(contentHex));
}

export function encodeBalanceOfCall(address: string): string {
  return `${ERC20_SELECTORS.balanceOf}${addressToTopic(address).slice(2)}`;
}

/** A JSON-RPC quantity (`0x1a`) as a bigint. */
export function hexQuantityToBigInt(value: string, field = "quantity"): bigint {
  if (typeof value !== "string" || !EVM_QUANTITY_PATTERN.test(value)) {
    throw invalid(field, value, "must be a 0x hex quantity");
  }
  return BigInt(value);
}

/** A JSON-RPC quantity that must fit a safe integer (block numbers, log indexes). */
export function hexQuantityToSafeInteger(value: string, field = "quantity"): number {
  const parsed = hexQuantityToBigInt(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid(field, value, "is outside the safe integer range");
  }
  return Number(parsed);
}

export function integerToHexQuantity(value: number | bigint, field = "quantity"): string {
  const big = typeof value === "bigint" ? value : BigInt(assertSafeNonNegativeInteger(value, field));
  if (big < BigInt(0)) {
    throw invalid(field, String(value), "must not be negative");
  }
  return `0x${big.toString(16)}`;
}

function assertSafeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(field, String(value), "must be a non-negative safe integer");
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function invalid(field: string, value: unknown, reason: string): DropshipError {
  return new DropshipError(
    DROPSHIP_EVM_ABI_INVALID,
    `EVM ABI value ${field} ${reason}.`,
    { field, value: typeof value === "string" ? value.slice(0, 200) : value, classification: "permanent" },
  );
}
