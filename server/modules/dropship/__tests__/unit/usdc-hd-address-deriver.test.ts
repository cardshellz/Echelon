import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import {
  DROPSHIP_USDC_XPUB_MISCONFIGURED,
  HdUsdcDepositAddressDeriver,
  USDC_XPUB_ENV,
} from "../../infrastructure/usdc-hd-address-deriver";

/**
 * The Hardhat / Foundry development mnemonic. Its first accounts are printed
 * by every local node, so the addresses below are a public, independently
 * checkable vector for the whole path: BIP-39 seed → m/44'/60'/0' → xpub →
 * 0/i → keccak of the public key.
 */
const DEVELOPMENT_MNEMONIC = "test test test test test test test test test test test junk";
const KNOWN_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

function developmentAccountKey(): HDKey {
  const seed = pbkdf2Sync(DEVELOPMENT_MNEMONIC.normalize("NFKD"), "mnemonic".normalize("NFKD"), 2048, 64, "sha512");
  return HDKey.fromMasterSeed(new Uint8Array(seed)).derive("m/44'/60'/0'");
}

describe("HdUsdcDepositAddressDeriver (funding design phase 6)", () => {
  const accountKey = developmentAccountKey();
  const xpub = accountKey.publicExtendedKey;

  it("derives the well-known development addresses from the account xpub alone", () => {
    const deriver = HdUsdcDepositAddressDeriver.fromExtendedPublicKey(xpub);
    KNOWN_ADDRESSES.forEach((known, index) => {
      const derived = deriver.deriveDepositAddress(index);
      expect(derived).toEqual({
        derivationIndex: index,
        address: known.toLowerCase(),
        checksumAddress: known,
        keyFingerprint: deriver.keyFingerprint,
      });
    });
    expect(deriver.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(deriver.keyFingerprint).toBe(accountKey.fingerprint.toString(16).padStart(8, "0"));
  });

  it("is deterministic: the same index always gives the same address, different indexes never collide", () => {
    const deriver = HdUsdcDepositAddressDeriver.fromExtendedPublicKey(xpub);
    const addresses = new Set(Array.from({ length: 50 }, (_, index) => deriver.deriveDepositAddress(index).address));
    expect(addresses.size).toBe(50);
    expect(deriver.deriveDepositAddress(7)).toEqual(HdUsdcDepositAddressDeriver.fromExtendedPublicKey(xpub).deriveDepositAddress(7));
  });

  it("refuses an extended key that carries a private key: the server is watch-only", () => {
    expect(() => HdUsdcDepositAddressDeriver.fromExtendedPublicKey(accountKey.privateExtendedKey))
      .toThrowError(expect.objectContaining({
        code: DROPSHIP_USDC_XPUB_MISCONFIGURED,
        message: expect.stringContaining("private key"),
      }));
  });

  it("refuses a key it cannot parse and indexes outside the non-hardened range", () => {
    expect(() => HdUsdcDepositAddressDeriver.fromExtendedPublicKey("xpub-not-really"))
      .toThrowError(expect.objectContaining({ code: DROPSHIP_USDC_XPUB_MISCONFIGURED }));
    const deriver = HdUsdcDepositAddressDeriver.fromExtendedPublicKey(xpub);
    expect(() => deriver.deriveDepositAddress(-1)).toThrowError(expect.objectContaining({ code: "DROPSHIP_USDC_DEPOSIT_INVALID" }));
    expect(() => deriver.deriveDepositAddress(2 ** 31)).toThrowError(expect.objectContaining({ code: "DROPSHIP_USDC_DEPOSIT_INVALID" }));
  });

  it("offers no deriver when the environment has no key, and trims a configured one", () => {
    expect(HdUsdcDepositAddressDeriver.fromEnv({})).toBeNull();
    expect(HdUsdcDepositAddressDeriver.fromEnv({ [USDC_XPUB_ENV]: "   " })).toBeNull();
    expect(HdUsdcDepositAddressDeriver.fromEnv({ [USDC_XPUB_ENV]: `  ${xpub}\n` })?.deriveDepositAddress(0).checksumAddress)
      .toBe(KNOWN_ADDRESSES[0]);
  });

  it("never exposes key material in its errors", () => {
    let caught: unknown;
    try {
      HdUsdcDepositAddressDeriver.fromExtendedPublicKey(accountKey.privateExtendedKey);
    } catch (error) {
      caught = error;
    }
    expect(JSON.stringify(caught)).not.toContain(accountKey.privateExtendedKey);
  });
});
