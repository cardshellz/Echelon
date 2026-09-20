/**
 * Per-vendor USDC deposit addresses from one watch-only key (funding design
 * phase 6).
 *
 * The operator generates a BIP-39 seed offline and exports only the
 * account-level extended PUBLIC key (BIP-44 for Ethereum: m/44'/60'/0') into
 * `DROPSHIP_USDC_BASE_XPUB`. From it the server derives receiving address
 * i as 0/i and the Ethereum address of that public key
 * (keccak256 of the uncompressed point, last 20 bytes). The spending key
 * never exists on the server: an extended key that carries a private key is
 * refused outright. The operator verifies index 0 against their own wallet
 * once (docs/DROPSHIP-USDC-CUSTODY-RUNBOOK.md).
 *
 * Libraries: @scure/bip32 and @noble/curves + @noble/hashes (audited, pure
 * JS). Hand-rolled curve arithmetic is not an option in a financial system.
 */

import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { DropshipError } from "../domain/errors";
import { depositDerivationPath, toChecksumAddress } from "../domain/usdc-deposits";

export const DROPSHIP_USDC_XPUB_MISCONFIGURED = "DROPSHIP_USDC_XPUB_MISCONFIGURED";
export const USDC_XPUB_ENV = "DROPSHIP_USDC_BASE_XPUB";

const FINGERPRINT_HEX_LENGTH = 8;
const UNCOMPRESSED_POINT_PREFIX_BYTES = 1;
const ADDRESS_BYTES = 20;
const KECCAK_BYTES = 32;

export interface DerivedUsdcDepositAddress {
  derivationIndex: number;
  /** Lowercase, for matching against the chain. */
  address: string;
  /** EIP-55 form, for showing the vendor. */
  checksumAddress: string;
  /** Fingerprint of the account key the address derives from. */
  keyFingerprint: string;
}

export interface UsdcDepositAddressDeriver {
  readonly keyFingerprint: string;
  deriveDepositAddress(derivationIndex: number): DerivedUsdcDepositAddress;
}

export class HdUsdcDepositAddressDeriver implements UsdcDepositAddressDeriver {
  readonly keyFingerprint: string;

  private constructor(private readonly accountKey: HDKey) {
    this.keyFingerprint = accountKey.fingerprint.toString(16).padStart(FINGERPRINT_HEX_LENGTH, "0");
  }

  /** Null when the variable is unset: USDC deposits are simply not offered. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HdUsdcDepositAddressDeriver | null {
    const raw = env[USDC_XPUB_ENV];
    if (raw === undefined || !raw.trim()) return null;
    return HdUsdcDepositAddressDeriver.fromExtendedPublicKey(raw.trim());
  }

  static fromExtendedPublicKey(extendedKey: string): HdUsdcDepositAddressDeriver {
    let key: HDKey;
    try {
      key = HDKey.fromExtendedKey(extendedKey);
    } catch (error) {
      throw new DropshipError(
        DROPSHIP_USDC_XPUB_MISCONFIGURED,
        "The USDC account extended public key cannot be parsed.",
        { env: USDC_XPUB_ENV, reason: error instanceof Error ? error.message : String(error), classification: "fatal" },
      );
    }
    if (key.privateKey !== null) {
      // The value is never logged: it would be a spending key.
      throw new DropshipError(
        DROPSHIP_USDC_XPUB_MISCONFIGURED,
        "The USDC account key carries a private key; the server holds the extended PUBLIC key only.",
        { env: USDC_XPUB_ENV, classification: "fatal" },
      );
    }
    if (key.publicKey === null) {
      throw new DropshipError(
        DROPSHIP_USDC_XPUB_MISCONFIGURED,
        "The USDC account extended key carries no public key.",
        { env: USDC_XPUB_ENV, classification: "fatal" },
      );
    }
    return new HdUsdcDepositAddressDeriver(key);
  }

  deriveDepositAddress(derivationIndex: number): DerivedUsdcDepositAddress {
    const path = depositDerivationPath(derivationIndex);
    const child = this.accountKey.deriveChild(path.change).deriveChild(path.index);
    const compressed = child.publicKey;
    if (compressed === null) {
      throw new DropshipError(
        DROPSHIP_USDC_XPUB_MISCONFIGURED,
        "Derived a child key without a public key.",
        { derivationIndex, classification: "fatal" },
      );
    }
    const address = ethereumAddressOf(compressed);
    return {
      derivationIndex,
      address,
      checksumAddress: toChecksumAddress(address, keccak_256),
      keyFingerprint: this.keyFingerprint,
    };
  }
}

/** keccak256 of the 64-byte uncompressed point (prefix byte dropped), last 20 bytes. */
function ethereumAddressOf(compressedPublicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(compressedPublicKey).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(UNCOMPRESSED_POINT_PREFIX_BYTES));
  const addressBytes = hash.subarray(KECCAK_BYTES - ADDRESS_BYTES);
  return `0x${Array.from(addressBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
