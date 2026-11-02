# Cancellation, payment and warehouse presentation

The sales-channel cancellation flag controls **Order: Cancelled**. It does not
prove a refund, a carrier delivery or completion of the local cancellation
strategy. Unshipped cancelled orders have no delivery track; actual delivery
evidence on previously shipped merchandise stays visible.

Payment retains Shopify's native financial status. While cancellation settlement
is active, the account combines its saved payment evidence with the existing
refund activity collection. The existing payment-settlement predicate and exact
receipt comparison determine when the cancellation refund is issued. Zero order
value, warehouse cancellation, rewards settlement and operation labels cannot
substitute for successful matched refund receipts. This reuses the existing v2
contract; no legacy client is sent a new required field or lifecycle enum.

The cancellation receipt reader checks paired OMS/channel/external-order/current
customer ownership and the persisted document/connection identities. It reads
only active operations, using the existing active-operation index. Completed
payment presentation returns to the native financial summary, without scanning
historical operation documents or calling payment/shipping providers. Failure
of this enrichment marks refund progress unavailable without hiding money,
delivery or physical returns.

Each meaningful cancellation observation refreshes the account summary. Visible
orders with pending cancellation settlement continue bounded read-only polling
after the panel closes. Hidden pages do not poll the provider; unmount aborts
reads. Confirmed native refunds or completed settlement stop polling even when
the independent action cache still contains an older phase. Polling never
submits or retries cancellation, refunds, rewards or hold commands.

Payment presentation uses `customerPaymentPresentation` in the native account
list and the order panel. An actual processing refund receipt makes **Refund
pending** the primary Payment status, rather than leaving **Paid** above small
supplemental text. Native **Refunded** wins over an older processing receipt.
Partial refunds remain explicit; a completed individual refund never implies
that the whole purchase is refunded. Missing refund evidence does not invent a
pending refund.

Returning to the account tab (window focus or visibility becoming visible)
refreshes its summaries through the existing read-only query, with overlapping
reactivation/settlement reads suppressed. This also covers an older summary
that contains no refund receipt and therefore cannot start settlement polling.
Hidden tabs do not refresh. A failed refresh retains already verified payment
facts; discovery of pending cancellation settlement starts the existing timer,
and native Refunded stops that timer. The compiled browser tests reproduce an
older empty-refund summary with unavailable cached actions, discover pending
refunds on tab reactivation, survive a failed read, and reach Refunded without
submitting any cancellation or financial command.

WMS terminal classification precedes the hold overlay. Cancelled/shipped orders
with retained hold history belong in their terminal buckets, not active Issues.
Neither HELD/ON HOLD badges nor priority hold controls advertise terminal orders
as paused work. SQL pagination/counts and shared client classification use the
same rule. Active held orders remain in Issues. No historical hold flag or
priority value is rewritten.

The cancellation strategy's completion rules are unchanged: verify the original
refunds and rewards, obtain fresh warehouse release proof, then atomically store
completion, retire provider receipts and clear only the operation-owned lock.
Independent manual holds stay recorded. Release retries must not repeat money
or rewards commands.

Validation covers real disposable PostgreSQL strategy/store/warehouse execution,
two original receipts, pending/partial/full refunds, lost replies, rewards and
release outages, replayed completion, preserved purchased quantities, customer
identity checks, future observations, SQL bucket parity, and compiled account plus
native Liquid desktop/mobile journeys. All providers and customer records in
these command tests are synthetic. The companion theme targets only unpublished
174740308127; no live order, points or inventory balance correction is included.
