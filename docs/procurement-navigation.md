# Procurement document navigation

Opening a shipment, receipt or invoice from a purchase carries an explicit purchase origin and a bounded trail of visited documents. The shared URL helpers reconstruct the parent document and selected tab without depending on browser history. A separate purchase-context link returns directly to the originating purchase tab, including from a copied link in a new browser tab.

`tab` identifies the current section. `purchase` contains a validated purchase reference and repeated `via` parameters contain validated document references. These are navigation metadata only; existing record access checks and financial/inventory commands remain responsible for authority. A shared shipment keeps its original purchase context when the user follows another linked PO. Arbitrary external return URLs, unsupported record kinds/tabs and noncanonical IDs are rejected. The trail keeps the most recent 12 parents while retaining the purchase exit.

Existing `/receiving?open=ID` links remain supported and now stay in the address bar. The receipt loads by ID independently of the receiving list. Loading, invalid links, missing records and access errors retain an exit; recoverable request errors offer Retry. Late receipt responses cannot replace a different record or a later visit to the same URL. Existing variant-creation sibling updates finish against the initiating receipt even when the user navigates away.

This is the first navigation slice. The proposed embedded purchase inspector, pre-PO sourcing workspace, line/filter/scroll restoration, lot drill-through, payment-page context and explicit purchase-context switching are subsequent work. Purchasing decisions and financial posting rules are outside this change.

## Verification

Run the focused unit and rendered component tests:

```sh
npx vitest run client/src/lib/__tests__/unit client/src/pages/__tests__/unit
npm run check
```

Run actual frontend browser journeys with fictional API responses:

```sh
npx playwright install chromium
npx playwright test --config playwright.procurement.config.ts
```

The browser suite starts Vite only, blocks service workers so API interception cannot be bypassed, and never starts the application server or connects to a database. Unexpected API mutations fail the tests; the delayed receipt test explicitly intercepts its one intended POST. Desktop/mobile cases cover native links and keyboard activation, browser Back/Forward, refresh, copied links, shared-shipment origins, receipts absent from the list, access-error retry, malformed IDs and delayed receipt actions. The Procurement navigation workflow runs these journeys on pull requests. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select a locally installed Chromium/Chrome binary instead of a downloaded test browser.
