# Order-options cache recovery

Account totals and Payment / Delivery / Return progress are independent of the
cached order-action inspection. A failed or expired action snapshot must not
be presented as an authoritative refusal to edit, change an address or cancel.

`POST /account/order-actions` remains a bounded read-only local lookup.
`POST /account/order-actions/refresh` authenticates the same signed account and
accepts the same bounded, paired order identities. It only promotes missing or
failed/expired presentation work in the existing worker queue, then reads the
projection. No provider call or financial, shipping, inventory or rewards
command runs in either HTTP path.

The queue promotion is atomic, coalesces repeated requests, respects live
leases, preserves the existing five-attempt budget and gives recently inspected
partial failures a one-minute cooldown. Healthy current snapshots are not
reinspected. A stopped inspection still requires source/configuration
invalidation; a customer request cannot override a permanent owner fault.

The first worker slot prioritizes urgent previously-inspected orders over the
historical refresh backlog. The second retains the existing historical lane,
so requesting current orders cannot starve initial history capture. An account
page requests recovery once when it observes unavailable options and polls
only the local projection afterward. Try again requests recovery explicitly.
Opening an already-loaded panel still starts no provider inspection.

The panel keeps verified money and independently loaded return navigation.
Missing action evidence disables actions without inventing policy reasons;
one failure message identifies the unavailable options. Successful current
owner inspections continue to supply real eligibility reasons. Commands
always revalidate against their existing owners.

Inspection diagnostics retain bounded error codes, never provider messages or
customer addresses. Cache refresh logs contain the signed principal, requested
count and admitted count. No customer/order-specific exception is included.

Validation uses disposable loopback PostgreSQL, mocked HTTP boundaries and the
actual compiled storefront bundle on desktop/mobile. No live refresh command
or customer order/points mutation is part of verification. Release the backend
before rebuilding the unpublished staging theme from the approved source.
