# Send selected inventory to Shopify

This is the legacy command retained for existing receipts and retries. Normal
product entry points now use [Sync one product's inventory through ATP](ATP-PRODUCT-INVENTORY-SYNC.md),
which applies the existing ATP rules across eligible destinations for one product.
The description below documents the legacy API's behavior.

Use **Send inventory** in the catalog product's **Channels → Shopify Product
Mapping** widget, a product row on **Shopify Channel**, or the selected product's
**Channel Inventory → Stock preview**. All three use the same command.

Choose the configured Shopify location and the variants to send. The dialog
calculates the quantity from active inventory and stock rules, including
reservations, holdbacks and publication limits. It supports a genuine zero and
does not accept a manually typed stock quantity. The preview does not write to
Shopify; **Send selected inventory** queues only those variants at that location.

Stock updates must be enabled globally and for the destination. Existing stock
links, eligibility and hold rules must be valid. Catalog product/variant mapping
and the canonical inventory link are separate evidence: a missing stock link
must be resolved through Channel Inventory's existing linking controls. This
action never changes those identities or enables paused stock updates.

The canonical publisher captures fresh availability inside the command's
serializable transaction. Its existing outbox owns the absolute Shopify update
and readback. **Verified at Shopify** requires the exact receipt's outbox row and
a dated observation of its requested quantity. Accepted or queued work is not
reported as verified. Later stock changes can supersede a queued update; the old
receipt then reports that replacement rather than another command's success.

Each send retains an actor-bound retry identity, immutable selection/quantity
receipt, and before/after audit evidence in the same transaction as its outbox
work. Session storage preserves the original request across a lost response or
reload. **Retry same send** recovers that command. A definitive stale-review
refusal requires fresh quantities; an uncertain response preserves its key.
Pending deliveries reuse their existing work. A new explicit send after completed
verification creates a fresh desired revision, even if availability is unchanged.

Permissions follow the existing inventory controls: `inventory_planning:view`
for context, review and progress, and `inventory_planning:activate` to send.
The interface supports up to 1,000 active variants in a product and 250 selected
variants per command; oversized requests fail explicitly. No warehouse quantity,
reservation, cost, product content, price or publication setting is changed.
