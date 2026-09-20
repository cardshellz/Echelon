import { describe, expect, it } from "vitest";
import {
  DROPSHIP_EVM_ABI_INVALID,
  ERC20_SELECTORS,
  addressToTopic,
  decodeAbiString,
  decodeUint256Word,
  decodeUint8Word,
  encodeBalanceOfCall,
  hexQuantityToBigInt,
  hexQuantityToSafeInteger,
  integerToHexQuantity,
  normalizeEvmAddress,
  topicToAddress,
} from "../../domain/evm-abi";

const ADDRESS = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDRESS_LOWER = ADDRESS.toLowerCase();
const ADDRESS_TOPIC = `0x000000000000000000000000${ADDRESS_LOWER.slice(2)}`;
const WORD_ONE = `0x${"0".repeat(63)}1`;

describe("EVM ABI helpers (funding design phase 6)", () => {
  it("normalizes addresses to lowercase and refuses anything else", () => {
    expect(normalizeEvmAddress(ADDRESS)).toBe(ADDRESS_LOWER);
    for (const bad of ["f39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0x12", "0xZZ9fd6e51aad88f6f4ce6ab8827279cfffb92266", ""]) {
      expect(() => normalizeEvmAddress(bad)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    }
  });

  it("moves an address into and out of its 32-byte topic form", () => {
    expect(addressToTopic(ADDRESS)).toBe(ADDRESS_TOPIC);
    expect(topicToAddress(ADDRESS_TOPIC.toUpperCase().replace("0X", "0x"))).toBe(ADDRESS_LOWER);
    // A topic whose leading bytes are not zero is not an address (a uint256 indexed value, say).
    expect(() => topicToAddress(`0x1${"0".repeat(63)}`)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => topicToAddress("0x1234")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
  });

  it("decodes words as unsigned integers, refusing wrong widths and uint8 overflow", () => {
    expect(decodeUint256Word(WORD_ONE)).toBe(BigInt(1));
    expect(decodeUint256Word(`0x${"f".repeat(64)}`)).toBe(BigInt(`0x${"f".repeat(64)}`));
    expect(decodeUint8Word(`0x${"0".repeat(62)}06`)).toBe(6);
    expect(() => decodeUint8Word(`0x${"0".repeat(61)}100`)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => decodeUint256Word("0x01")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
  });

  it("decodes an ABI string return value, the way symbol() answers", () => {
    const usdc = Buffer.from("USDC", "utf8").toString("hex").padEnd(64, "0");
    const encoded = `0x${"0".repeat(62)}20${"0".repeat(63)}4${usdc}`;
    expect(decodeAbiString(encoded)).toBe("USDC");
    expect(decodeAbiString(`0x${"0".repeat(62)}20${"0".repeat(64)}`)).toBe("");
    // Length beyond the data, or an offset outside it, is refused.
    expect(() => decodeAbiString(`0x${"0".repeat(62)}20${"0".repeat(62)}ff${usdc}`)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => decodeAbiString(`0x${"0".repeat(62)}ff${"0".repeat(64)}`)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => decodeAbiString("0x1234")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => decodeAbiString("0x123")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
  });

  it("encodes a balanceOf call as the selector plus the padded address", () => {
    expect(encodeBalanceOfCall(ADDRESS)).toBe(`${ERC20_SELECTORS.balanceOf}${ADDRESS_TOPIC.slice(2)}`);
    expect(encodeBalanceOfCall(ADDRESS)).toHaveLength(2 + 8 + 64);
  });

  it("parses JSON-RPC quantities, keeping block numbers in the safe integer range", () => {
    expect(hexQuantityToBigInt("0x1a")).toBe(BigInt(26));
    expect(hexQuantityToBigInt("0x0")).toBe(BigInt(0));
    expect(hexQuantityToSafeInteger("0x1fffffffffffff")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => hexQuantityToSafeInteger("0x20000000000000")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => hexQuantityToBigInt("0x")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => hexQuantityToBigInt("26")).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
  });

  it("formats block numbers as hex quantities and refuses negatives and fractions", () => {
    expect(integerToHexQuantity(0)).toBe("0x0");
    expect(integerToHexQuantity(35_000_000)).toBe("0x2160ec0");
    expect(integerToHexQuantity(BigInt(255))).toBe("0xff");
    expect(() => integerToHexQuantity(-1)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => integerToHexQuantity(BigInt(-1))).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
    expect(() => integerToHexQuantity(1.5)).toThrowError(expect.objectContaining({ code: DROPSHIP_EVM_ABI_INVALID }));
  });
});
