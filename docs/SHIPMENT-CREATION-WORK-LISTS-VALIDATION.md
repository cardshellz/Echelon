# Shipment creation and work lists: local acceptance

Date: 2026-10-18. Reviewed base: `d5a04cb66dbf1aa8ddb1f6d8931d66fbf32ba538`. See `SHIPMENT-CREATION-WORK-LISTS.md` for the command/read trace and release limits.

| Check | Result |
| --- | --- |
| Procurement, client and CI guard tests | 4,817 passed across 283 files; seven existing DB-dependent exception tests skipped |
| PostgreSQL | 141 passed across nine suites, each using a fresh disposable database |
| Desktop/mobile browsers | 232 distinct cases passed; focused reruns are not counted twice |
| Types | Application, server tests, client tests and changed browser specs passed |
| Production build | Passed; existing bundle-size advisory remains |
| Migration and coverage guards | Passed; three new PostgreSQL suites registered; no migration or exclusion expansion |

PostgreSQL suites: shipment-create-recovery (16), shipment-work-list (6), ap-work-lists (10), shipment-line-commands (52), shipment-purchase-orders (3), ap-financial-safeguards (13), inbound-tracking (19), procurement-flow-cost-controlled-acceptance (3), invoice-replacement (19). No PostgreSQL cases were skipped. The local test cluster was stopped after validation.

Browser coverage: shipment lists/current costing/purchase links (64), AP lists/safeguards/invoice replacement/PO evidence (108), creation recovery (30), shipment line commands and complete PO selection (30). Screens were exercised at desktop and mobile sizes with controlled API responses. The creation dialogs were visually checked after bounding their height and adding internal scrolling.

The real database tests caught PostgreSQL selecting the regex overload for an untyped substring parameter; an explicit integer cast corrects number allocation. They also verify deterministic sequence exhaustion as a durable rejection with manual-number recovery. Fixture setup casts, retry timing and UTC readback were corrected without removing assertions. An existing forecast route fixture failed before HTTP dispatch because Fetch rejected its temporary port; that fixture now uses Node HTTP with bounded timeout and explicit errors. The original allocated port was not logged, so no particular port is claimed.

These results establish local behavior against synthetic data. They do not establish hosted CI, deployment, production data repair, production-scale cost-filter latency or owner acceptance. Cost filtering scans complete candidate evidence in bounded pages; offset paging shares one snapshot per response, not across an entire browsing session. No historical partial draft was automatically deleted or reclassified.
