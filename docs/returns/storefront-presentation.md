# Integrated storefront returns

The native Shopify returns page uses the store header/footer, one page heading,
one content column and a responsive help rail. `CustomerReturnStorefrontLayout`
supplies presentation context only. `CustomerReturnSurface` and
`CustomerReturnHeading` remove duplicate application branding and use subsection
headings inside that context. The account dialog and standalone application keep
their existing branded surfaces and navigation.

Guest lookup, code verification and verified-order access use the same page
layout. Optional account activation is secondary help-rail content, rather than
a separate card above the return flow. Its existing verification, request keys,
server identity checks and new-tab activation behavior are unchanged.

The chooser distinguishes an empty successful lookup from a failed lookup.
Storefront history is rendered as order/return summaries, with the original
authorization reference secondary. Normal refreshes run as saved reads when the
visible chooser regains focus and every minute while visible; they never replay
a return or a postage command. Explicit retry appears for read failures. A
customer may open another purchase's guest lookup without signing out of Shopify.

## Summary authority and compatibility

The optional `progress` history field uses the existing
`PostgresCustomerReturnProgressReader` and return-progress domain. One bounded
read enriches the owned history page from saved case, receipt, label, tracking
and refund facts. It does not run purchase eligibility, read a provider, generate
a label or modify the original order. Guest reads retain the same exact purchase
predicate as their history authorization, including a missing imported customer.

Physical return progress and refund status remain separate. Label readiness does
not mean receipt or refund. In a rolling deployment, old history responses without
progress still render a working "View return" action. A failed progress read is
logged as `RETURN_HISTORY_PROGRESS_UNAVAILABLE` and does not hide accepted history
or claim a physical/financial status.

A label-ready single-box summary offers "Download label". The action first reads
current label status and then uses the existing protected artifact downloader.
A stale summary never grants download access. Multiple boxes open the existing
per-box label view. Downloads never enqueue new postage.

## Companion theme change

The companion theme adds `csz-return-storefront` to the body only for
`page.return-portal`. The returns section changes that page's body to a vertical
flex layout, retaining the actual store header, breadcrumb, main and footer.
The public page's existing four-row grid assigns `1fr` to the third rendered row;
the inserted breadcrumb occupies that row and expands into a blank dark banner.
Other templates retain their existing body classes and grid behavior.

Rebuild `csz-return-portal.js/css` from a clean, committed source revision, pin its
hashes in the theme manifest, and deploy the history reader before the companion
assets. This feature needs no schema, pricing, payment, inventory or points change.

## Verification

The compiled native browser suite covers single-page guest access, lost replies,
expiry, one-click protected downloads, stale label evidence, multiple boxes,
empty versus failed reads, older backend responses, focus refresh, separate
physical/refund status and widths down to 320px. Existing account/dialog and
standalone journeys remain regression coverage.

The connected PostgreSQL complex-flow test exercises three outbound shipments,
two mixed return boxes, label/capture retries, receiving and independent refund
facts. Its history assertions use the actual reader and verify channel/customer/
exact-purchase isolation, including a null imported customer. All provider calls
and customer records in these checks are synthetic. Native account activation,
real email delivery and real postage purchase are outside this presentation test.
