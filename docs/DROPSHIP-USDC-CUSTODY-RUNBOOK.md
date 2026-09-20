# Dropship USDC custody — operator runbook

How Card Shellz holds vendors' USDC deposits (funding design phase 6). The
design is recorded in `docs/DROPSHIP-WALLET-FUNDING-DESIGN.md`; this page is
the procedure. Read it before touching any key.

## The model in one paragraph

Vendors send USDC on the Base network to an address that is theirs alone.
Every such address is derived from one account key that Card Shellz
controls. The server holds only the account's extended **public** key, so it
can derive addresses and watch them but can never spend from them. The
spending key (the seed phrase) lives offline. Moving money out of the
vendor addresses (a "sweep") is done by a person with that seed, never by
the application.

## The key ceremony (once)

1. On a machine that is offline, or with a hardware wallet, generate a new
   BIP-39 seed phrase. Write it down; never type it into a server, a chat, a
   ticket, or a password manager shared with the application's secrets.
2. Derive the Ethereum account at BIP-44 path `m/44'/60'/0'` and export its
   **extended public key** (`xpub…`). Hardware wallets and most desktop
   wallets can export this; it starts with `xpub`, never with `xprv`.
3. Set `DROPSHIP_USDC_BASE_XPUB` on the application to that value. The
   server refuses an `xprv` outright and logs
   `DROPSHIP_USDC_XPUB_MISCONFIGURED`; that refusal is a safety net, not a
   workflow.
4. Verify the key and path once: open the admin custody report
   (`GET /api/dropship/admin/wallet/usdc/custody`) and compare its
   `verificationAddress` (index 0 under the key) with the first receiving
   address your wallet shows for the same account. They must match exactly.
   If they do not, the path or the key is wrong; fix it before any vendor is
   handed an address. Vendor addresses are index 0, 1, 2 … under the same
   key, so a wallet restored from the seed sees every deposit.
5. Record the key fingerprint the report shows (`keyFingerprint`) in the
   operations log. Addresses carry it, so a later key rotation never reuses an
   index and old addresses stay attributable.

## Watching deposits

- `DROPSHIP_USDC_BASE_RPC_URL`: an https JSON-RPC endpoint for Base mainnet
  (chain id 8453). Before any scan the watcher checks the chain id and that
  the token contract answers `symbol() == "USDC"` and `decimals() == 6`; a
  mismatch is logged as `DROPSHIP_USDC_CHAIN_UNVERIFIED` and nothing is
  credited.
- `DROPSHIP_USDC_WATCHER_ENABLED=true` runs the watcher worker. It ticks every
  30 s (`DROPSHIP_USDC_WATCHER_INTERVAL_MS`) under an advisory lock, so more
  than one dyno never scans at once.
- Timing: a transfer is credited to the vendor's pending balance after 6
  confirmations (`DROPSHIP_USDC_WATCHER_MIN_CONFIRMATIONS`) and becomes
  available once its block is at or below the network's `safe` head
  (`DROPSHIP_USDC_WATCHER_SETTLE_TAG`, `safe` or `finalized`). A transfer
  whose receipt disappears is voided once the chain has moved 60 blocks past
  its block (`DROPSHIP_USDC_WATCHER_VOID_AFTER_BLOCKS`).
- Enabling the watcher late: with no cursor on record the first scan starts at
  the current head. If vendors were handed addresses before the watcher ran,
  set `DROPSHIP_USDC_WATCHER_START_BLOCK` to a block before the first
  possible deposit for the first run, then unset it.
- What the log says and what to do:
  - `DROPSHIP_USDC_SCAN_STOPPED` with `requiresReview: true`: a transfer could
    not be recorded and the scan will not move past it. Read the error code
    in the line, fix the cause, and the next tick continues.
  - `DROPSHIP_USDC_DEPOSIT_VOIDED`: the network dropped a transfer after it
    was credited pending; the vendor has been told. Nothing to do unless it
    comes back (below).
  - `DROPSHIP_USDC_DEPOSIT_REAPPEARED`: a voided transfer is back on chain.
    Automation never re-credits it. Credit it by hand (below) with the
    transaction hash and log index the line carries.
  - `DROPSHIP_USDC_CUSTODY_UNRECORDED_FUNDS`: an address holds USDC the ledger
    never credited. Find the transfer on a block explorer and credit it by
    hand, or, if it is not USDC on Base, leave it: it is not the vendor's.

## Crediting a deposit by hand

`POST /api/dropship/admin/wallet/usdc/confirmed-credit` (staff with
`dropship:manage_operations`). The dollar amount must be the USDC amount in
whole cents (atomic units ÷ 10,000, rounded down), the `toAddress` must be
the vendor's own address or the shared one, and for a batched transaction
name the `logIndex` of the vendor's transfer so the watcher and the manual
credit agree on which transfer it was. A duplicate is refused as
`DROPSHIP_USDC_TRANSACTION_CONFLICT`.

## Sweeping to the treasury

The application never sweeps. To move deposits out of the vendor addresses:

1. Read the custody report: `addresses[].onChainAtomicUnits` is what sits at
   each address now; `expectedAtomicUnits` is what the ledger credited there
   (plus dust) before any sweep. A `status` of `holding` or `partly_swept` is
   normal; `unrecorded_funds` needs the check above first.
2. In the offline wallet restored from the seed, send the USDC from each
   address to the treasury address. Each vendor address needs a little ETH
   on Base for gas first; send it from the treasury.
3. After the sweep the report shows `swept` (or `partly_swept` while dust
   remains). Nothing in the ledger changes: vendor balances are ledger
   numbers, and the sweep only moves the backing funds.

## Rotating the key

Set a new `DROPSHIP_USDC_BASE_XPUB` (after the ceremony above for the new
seed). Vendors keep their existing addresses under the old fingerprint; the
watcher keeps watching them, and the old seed is still needed to sweep
them. New vendors get addresses under the new key from index 0. Do not delete
address rows: they are the only link between a deposit and its vendor.

## What must never happen

- The seed phrase or an `xprv` on any server, in any environment variable, or
  in any log.
- Handing out an address that was not derived from the configured key.
- Crediting a USDC transfer whose amount was not read from the chain (or
  from the transaction on a block explorer) in atomic units.
- Editing a `dropship_usdc_deposit_addresses` row by hand.
