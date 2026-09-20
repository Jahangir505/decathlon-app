# Synchronization Strategy

## 1. Product/offer matching priority (Shopify → Decathlon)

Since this app creates the Decathlon-side listing (not the reverse), "matching" means: does a
`ProductMapping` already exist for this Shopify variant, and if so, is its Decathlon identity still
valid?

1. `ProductMapping.decathlonProductId` / `decathlonOfferId` if already set (fastest path — direct update).
2. `shopSku` (the SKU we send to Decathlon as `shop_sku`) via `P31 GET /api/products` lookup, to detect
   if a listing already exists on Decathlon that this app hasn't mapped yet (e.g. created by another
   tool) before creating a duplicate.
3. `ean` as a secondary check when SKU alone is ambiguous.
4. Never match on title.

For inbound order-line matching (Decathlon order line → Shopify variant), the same priority applies in
reverse: `ProductMapping` keyed by `decathlonProductId`/`decathlonOfferId` first, then `sku`, then
`ean`. A line that matches nothing is **not silently dropped** — the order is created with that line
flagged `UNMATCHED` and the order's `matchStatus` set to `PENDING` for manual resolution in the mapping
UI (per requirement §8's "manually map products if automatic matching fails").

## 2. Idempotency

- **Product sync**: Mirakl's `P41` import is upsert-by-`shop_sku`, so re-running product sync is
  naturally idempotent at the Decathlon end. Locally, `ProductMapping` is uniquely keyed on
  `(shopId, shopifyVariantId)` — the sync job does `upsert`, never `create`.
- **Offer sync**: same — `OF01`/`OF24` are upsert by shop_sku/offer id.
- **Order import**: guarded by `@@unique([shopId, decathlonOrderId])` on `OrderMapping` (see
  `docs/database-design.md` §3). The import job always checks-then-creates inside a transaction; a
  unique-constraint violation on concurrent execution is treated as "already imported," not an error.
- **Fulfillment/refund push**: before calling `OR23`/`OR24`/`OR28`, check `OrderMapping.decathlonShipmentId`
  / a `SyncLog` record for that action+order — do not re-confirm a shipment or re-issue a refund that
  already succeeded. Mirakl's endpoints are not guaranteed idempotent on the Decathlon side, so this
  app's own state is the idempotency guard.

## 3. Sync state machine

Applied to `SyncJob.status` and reflected per-item in `SyncLog.status` / `ProductMapping.status`:

```
PENDING → PROCESSING → SUCCESS
                     └→ FAILED → RETRYING → PROCESSING (loop, bounded by max retry count)
                                          └→ FAILED (terminal, after max retries)
PENDING → SKIPPED   (e.g. duplicate order already imported)
```

`retryCount`, `lastAttemptAt`-equivalent (`updatedAt`), `lastError` are stored per requirement §34.

## 4. Retry / backoff

Exponential backoff on `429`/`502`/`503`/network timeout: 2s → 4s → 8s → 16s → 32s, capped at 5
attempts, then the job moves to `FAILED` and surfaces on the Failed page for manual retry. Respect a
`Retry-After` header if Decathlon returns one (unconfirmed whether it does — defensive handling only).
Each endpoint's documented **maximum call frequency** (see `docs/api-mapping.md` §2) is enforced as a
hard scheduling ceiling, independent of backoff — e.g. `OR11` is never polled more than once per
minute regardless of how many jobs want to run it (implemented via a BullMQ rate-limited queue).

## 5. Order polling schedule

- Configurable interval per shop: 5 / 10 / 15 / 30 minutes (`SyncConfiguration.orderImportIntervalMinutes`,
  default 15 — matching Decathlon's own "Recommended usage: every 15 minutes" guidance for external
  partners on `OR11`).
- Each poll: `GET /api/orders?order_state_codes=SHIPPING`, offset-paginated, sorted `dateCreated` asc
  so earlier orders are imported first and a crash/restart mid-page resumes forward safely (track last
  processed offset/order id per shop, not just "last run time," since offset pagination can shift if
  new orders land mid-page — re-derive from `dateCreated` cursor rather than raw offset where possible).
- No webhook exists for Decathlon orders (confirmed absence, see `docs/api-mapping.md` §0) — polling is
  the only mechanism, so the scheduling ceiling in §4 above is load-bearing, not optional.

## 6. Pricing rules

`SyncConfiguration.priceMarkupPercent` / `priceDiscountPercent` apply when computing the price pushed
to Decathlon via `OF01`/`OF24` from the Shopify variant's price — configurable per shop, never
hard-coded, per requirement §11. `defaultCurrency` governs the currency field sent in offer payloads;
no currency conversion is performed (out of scope unless Decathlon's actual offer schema requires a
specific currency and the shop's Shopify currency differs — flag if discovered during Phase 5).

## 7. Order status mapping

Decathlon's real order lifecycle observed so far (from the docs provided): orders only become visible
to the seller once in `SHIPPING` (awaiting shipment) status — everything before that (payment capture,
acceptance) happens on Decathlon's side, invisible to this app. After that:

| Decathlon order_state_code (as observed) | Meaning | Shopify-side representation |
|---|---|---|
| `SHIPPING` | Awaiting seller shipment | Shopify order created, unfulfilled |
| *(post-shipment status codes not yet documented)* | Shipped/delivered | **UNCONFIRMED** — OR11 response schema not yet provided; do not assume specific codes |

This table intentionally stays sparse — the full set of `order_state_code` values not yet
provided are marked **UNCONFIRMED** rather than guessed, per the project's explicit instruction not to
invent statuses. `SyncConfiguration.statusMapping` is a `Json` field specifically so this table can be
completed and made configurable without a schema migration once the real values are known.

## 8. Inventory/stock rules

- Never push a negative stock value to Decathlon (clamp at 0).
- Out-of-stock Shopify variants push `quantity: 0` via offer sync rather than deleting/deactivating the
  Decathlon listing, unless Decathlon's offer schema has an explicit active/inactive flag (unconfirmed
  — check the real OF01/OF24 request schema in Phase 5).
- Multi-location Shopify inventory: sum available quantity across locations for the single stock figure
  Decathlon's offer expects, unless/until Decathlon's schema is shown to support per-location stock
  (unconfirmed).

## 9. Large-catalogue handling

- `P41`/`OF01` are batch/async imports — never build the full payload in memory for the whole catalogue;
  chunk into batches (size TBD by the real P41 payload limits, not yet documented) and enqueue one
  BullMQ job per batch.
- `P31`/`OR11` reads are paginated (100 max per P31 call, offset pagination for OR11) — the sync engine
  always follows pagination to completion rather than assuming a single page, and persists a cursor so
  an interrupted run resumes rather than restarting.

## 10. What Phase 1 deliberately leaves unresolved

Per `docs/api-mapping.md` §4, these require confirmation before implementation is considered
production-ready: exact auth header, full request/response JSON schemas for P41/OF01/OF24/OR11/OR23/
OR24/OR28/RT01/RT04, real rate-limit header format, and the complete Decathlon order status vocabulary.
None of these block Phase 1 sign-off (architecture/DB/strategy), but Phase 3 (Decathlon client) and
Phase 6 (order import) cannot be marked complete until they're confirmed against real API responses.
