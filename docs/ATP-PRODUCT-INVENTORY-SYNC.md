# Sync one product's inventory through ATP

Use **Sync inventory** from the catalog product's Channels panel, a Shopify
product-feed row, or Channel Inventory's selected product stock preview. Each
entry point selects the catalog product only. Opening it from a Shopify page does
not restrict the sync to Shopify.

The review recalculates availability for this product using the canonical ATP
publisher. The publisher determines the variants, destinations, source warehouses,
listing eligibility, reservations, holdbacks, shares and publication limits.
The action does not accept quantities or destination overrides. It does not create
listings or change stock rules, publication controls or warehouse inventory.

The review shows calculated quantities for eligible destinations and reasons for
blocked or skipped destinations. Existing ATP isolation applies: a blocked
destination remains blocked; supported destinations with an individual missing
stock link may still receive their other eligible variants. Global pause prevents
the command. A product with no publishable work cannot be submitted.

**Sync eligible inventory** records the reviewed safe publication work in the canonical
outbox. The server checks the review again inside a serializable transaction.
Changed quantities, links or rules require another review. The command, exact
outbox identities and audit record commit together. A failed transaction rolls
back the entire local command.

Delivery happens through the existing provider admission and outbox workers.
Queued or acknowledged work is not verified inventory. Verification requires the
receipt's exact outbox record, a matching observed quantity and a readback time.
A later inventory update can supersede an earlier queued revision; that earlier
receipt reports superseded rather than claiming the later command succeeded.

The browser retains an actor-scoped retry identity before submitting. After an
uncertain response or reload, **Retry same sync** recovers that command. Replaying
the same command does not make another desired revision. A fresh explicit sync
after completed verification can request a fresh publication even when the
calculated quantity is unchanged.

## Missing stock links

A catalog listing identity and an active ATP stock-publication link are separate
records. The stock-link owner establishes the latter from provider evidence; this
sync does not manufacture a link from a catalog mapping.

For Shopify, the existing stock-link rule requires product status `ACTIVE`.
`DRAFT` and `ARCHIVED` products are not linked by that rule. A saved
`STOCK_LINK_NOT_ON_SALE` diagnostic describes the last stock-link check, not a new
provider read. Review the listing's intended lifecycle and the stock-link status
in Channel Inventory. This inventory command does not publish a draft listing or
change its lifecycle.

## Compatibility and permissions

The previous Shopify-only action is replaced at normal entry points. Its API and
receipt reader remain available for existing saved commands; their retry identity
must never be converted into a new all-channel command.

Review and progress require `inventory_planning:view`; synchronization requires
`inventory_planning:activate`. The request contains only the product identity,
review hash and idempotency key. The implementation is bounded to 1,000 product
variants, 1,000 configured targets and 10,000 target/variant review rows, and
refuses oversized operations explicitly.
