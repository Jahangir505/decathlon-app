# Architecture — Shopify ↔ Decathlon Partner (Mirakl) Integration

## 1. What this app actually does

Decathlon Partner's API is the **Mirakl Seller API**: Decathlon operates a marketplace, and the
Shopify merchant is a **seller** on it. See `docs/api-mapping.md` §0 for the evidence. Concretely:

- The merchant's **own Shopify products** get listed for sale on Decathlon (product + offer/price/stock).
- **Customers who buy on Decathlon's marketplace** generate orders that must be fulfilled — this app
  imports those orders into Shopify (for inventory/ops visibility and fulfillment tracking) and pushes
  shipment/tracking/refund status back to Decathlon.
- There is no "import Decathlon's catalogue into Shopify" capability — do not build that.

This flips the direction of "catalogue sync" from a naive reading of a generic integration brief, but
matches exactly what the Mirakl Seller API supports.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend runtime | Node.js + TypeScript (strict) | Required by project standards |
| Backend framework | NestJS | Modular DI, first-class support for queues/schedules/config, scales better than raw Express for a multi-module sync engine |
| API style | REST (internal admin API) + Shopify GraphQL Admin API (outbound) | GraphQL Admin API is Shopify's current recommendation; internal API stays REST for simplicity |
| DB | PostgreSQL + Prisma ORM | Strong relational guarantees for uniqueness constraints (dedup orders/products), migrations, typed client |
| Queue | BullMQ + Redis | Required for async catalogue/order jobs, retries, backoff, progress reporting |
| Frontend | React + TypeScript + Shopify Polaris + App Bridge | Embedded admin UI, current Shopify recommendation |
| Auth (Shopify) | Shopify OAuth (online/offline token per current Shopify app architecture, no deprecated APIs) | Multi-tenant session storage in Postgres |
| Auth (Decathlon) | Mirakl API key per shop, stored encrypted | Merchant-supplied, tested via a connection-check call |
| Secrets | Environment variables + encryption-at-rest for stored third-party credentials (Decathlon API key, Shopify offline token) | Never in frontend, never in logs |

## 3. Layered / hexagonal architecture

The core rule: **Decathlon-specific logic and Shopify-specific logic never call each other directly.**
Everything passes through normalized internal models and a sync engine, per the project's own
architecture requirement.

```
 Decathlon (Mirakl) REST API
          │
          ▼
 packages/decathlon  (DecathlonClient, response schemas, pagination/retry/backoff)
          │  raw Mirakl DTOs
          ▼
 Decathlon Adapter    (maps Mirakl DTOs → Normalized models)
          │  NormalizedProduct / NormalizedOffer / NormalizedOrder / NormalizedReturn
          ▼
 packages/sync         (Sync Engine: product-sync, offer-sync, order-import,
                         fulfillment-sync, refund-sync — state machine + idempotency)
          │  Normalized models
          ▼
 Shopify Adapter      (maps Normalized models → Shopify Admin GraphQL mutations/queries)
          │
          ▼
 packages/shopify     (ShopifyClient, GraphQL Admin API, webhooks, OAuth)
          │
          ▼
 Shopify Admin API / Webhooks
```

Both adapters are swappable independently — e.g. Shopify Admin API version bumps only touch
`packages/shopify`; a future non-Decathlon Mirakl marketplace could reuse `packages/sync` by writing
a new adapter instead of `packages/decathlon`.

## 4. Monorepo structure

```
shopify-decathlon-app/
├── apps/
│   └── web/
│       ├── frontend/        # React + Polaris + App Bridge embedded admin UI
│       └── backend/         # NestJS app: HTTP API, OAuth callback, webhook receivers
├── packages/
│   ├── shopify/             # ShopifyClient, GraphQL operations, webhook verification, OAuth
│   ├── decathlon/           # DecathlonClient (Mirakl), response schemas (Zod), adapter
│   ├── database/            # Prisma schema + generated client + repositories
│   ├── sync/                # Sync engine: jobs, state machine, normalized models, matching
│   ├── logger/              # Structured logger (pino), correlation IDs, secret masking
│   └── shared/               # Cross-cutting types, error classes, config loader
├── worker/                  # BullMQ worker process(es) — separate deployable from the API
├── prisma/
│   └── schema.prisma
├── docker/
├── docs/
├── .env.example
├── docker-compose.yml
├── package.json
└── README.md
```

`worker/` is deliberately its own deployable (per requirement #18: never run large imports inside an
HTTP request). The NestJS `apps/web/backend` process enqueues jobs; `worker/` processes them.

## 5. Data flow — product/offer sync (Shopify → Decathlon)

```
Merchant clicks "Sync Product to Decathlon"
        │
        ▼
NestJS API enqueues `product-sync` job (BullMQ) — returns immediately
        │
        ▼
Worker: fetch Shopify product (GraphQL Admin API)
        │
        ▼
Normalize → NormalizedProduct (sku, ean/barcode, title, description, images,
            brand, category mapped via H11 taxonomy, attributes via PM11/VL11)
        │
        ▼
Validate against Decathlon attribute config (PM11) — required attrs present?
        │
        ▼
Look up ProductMapping (shopId + shopifyProductId/variantId)
        │
   ┌────┴─────┐
   │ exists?  │
   └────┬─────┘
  no ───┤─── yes
   │         │
   ▼         ▼
Build P41   Build P41 update
import      payload (same
payload     API — Mirakl
   │        import is upsert
   └────┬───┘
        ▼
POST /api/products/imports (P41) → import_id
        ▼
Poll P42 until terminal status
        ▼
On success: build OF01/OF24 payload (price + stock from Shopify variant)
        ▼
Push offer → save ProductMapping (decathlonProductId/offerId, lastSyncedAt)
        ▼
Write SyncLog (request/response summary, secrets masked)
```

Running this twice for the same Shopify product/variant must not create a second Decathlon listing —
Mirakl's import API is upsert-by-`shop_sku`, and `ProductMapping` is uniquely keyed on
`(shopId, shopifyVariantId)`, so the second run resolves to an **update** path.

## 6. Data flow — order import (Decathlon → Shopify)

```
Scheduled poll (respecting OR11 rate limit — see api-mapping.md §2.4)
        │
        ▼
GET /api/orders?order_state_codes=SHIPPING (OR11, paginated)
        │
        ▼
For each Decathlon order:
   check OrderMapping WHERE (shopId, decathlonOrderId) UNIQUE
        │
   ┌────┴─────┐
   │ exists?  │
   └────┬─────┘
  yes ──┤── no
   │        │
   ▼        ▼
 skip    Match each order line's SKU/EAN → ProductMapping → Shopify variant
(dup)       │
            ▼
        Any line unmatched? → mark order PARTIALLY_MATCHED, flag for manual mapping
            │
            ▼
        Create Shopify order (Admin API) with:
          - line items (matched variants, qty, price)
          - customer/shipping/billing (where permitted)
          - Decathlon order id + status stored in order metafields/tags
            │
            ▼
        Save OrderMapping (shopId, shopifyOrderId, decathlonOrderId, status)
            │
            ▼
        Write SyncLog
```

Because Decathlon **auto-accepts** orders before this app ever sees them (payment captured up front),
there is no accept/refuse step (`OR21` is not used) — this app's job starts at "fetch orders awaiting
shipment" and ends at "confirm shipment + push tracking".

## 7. Data flow — fulfillment & refunds (Shopify → Decathlon)

```
Shopify fulfillment created (webhook: FULFILLMENTS_CREATE)
        │
        ▼
Find OrderMapping by shopifyOrderId
        │
        ▼
Build shipment confirmation payload → POST .../shipments (OR23)
        │
        ▼
Build tracking payload (carrier, tracking number/url) → PUT .../shipments/{id} (OR24)
        │
        ▼
Update OrderMapping.decathlonOrderStatus, write SyncLog
```

```
Shopify order cancelled / refunded (webhook: ORDERS_CANCELLED, or admin action)
        │
        ▼
Find OrderMapping
        │
        ▼
POST /api/orders/{id}/refunds (OR28) — used for ALL post-payment cancel/return/adjustment cases
        │
        ▼
If a formal return record is needed: POST /api/returns (RT01), then PUT /api/returns (RT04) for
tracking/RMA, or POST /api/returns/cancel (RT29) if the return itself is cancelled
```

## 8. Multi-tenancy

Every table carries `shopId`. Every Prisma query is scoped by it — no exceptions. See
`docs/database-design.md`. Shopify session tokens and Decathlon API keys are stored per-`Shop` row,
encrypted at rest (`ENCRYPTION_KEY` env var, AES-256-GCM), never logged, never sent to the frontend.

## 9. Background jobs (BullMQ queues)

| Queue | Trigger | Purpose |
|---|---|---|
| `product-sync` | manual "Sync Product(s)", or automatic on Shopify PRODUCTS_UPDATE webhook (if auto-sync enabled) | Push product to Decathlon (P41) |
| `offer-sync` | manual, or automatic on Shopify INVENTORY_LEVELS_UPDATE / price change | Push stock/price (OF24, batched to OF01 for bulk) |
| `order-import` | scheduled poll (interval configurable 5/10/15/30 min, respecting OR11 rate limits) | Pull new Decathlon orders (OR11) → create Shopify orders |
| `fulfillment-sync` | Shopify FULFILLMENTS_CREATE/UPDATE webhook | Push shipment + tracking to Decathlon (OR23/OR24) |
| `refund-sync` | Shopify ORDERS_CANCELLED webhook, or admin-triggered refund | Push refund to Decathlon (OR28), optionally create/update a Return (RT01/RT04) |
| `import-status-poll` | after any P41/OF01 call | Poll P42/OF02 until terminal, then fetch reports (P44/P45, OF03) |
| `retry-failed-sync` | scheduled sweep | Re-enqueue jobs left in `RETRYING`/`FAILED` under retry budget |

## 10. Shopify webhooks actually required

Given the confirmed direction (products pushed out, orders pulled in), only these webhooks are needed
— not the full list in the original brief:

- `PRODUCTS_UPDATE` — trigger re-sync to Decathlon if auto product sync is on
- `INVENTORY_LEVELS_UPDATE` — trigger offer stock push
- `FULFILLMENTS_CREATE`, `FULFILLMENTS_UPDATE` — push shipment/tracking to Decathlon
- `ORDERS_CANCELLED` — push refund to Decathlon
- `APP_UNINSTALLED` — clean up shop data / stop schedules

`ORDERS_CREATE`/`ORDERS_UPDATED` are **not** needed for the Decathlon direction — Shopify orders here
are created *by this app itself* from Decathlon data, not by the merchant's storefront. (If the
merchant also sells Decathlon-listed products through their own storefront and needs inventory
consistency there, that's a separate concern from this integration and should be scoped explicitly if
wanted.)

## 11. Security notes specific to this integration

- Decathlon API key: encrypted column, decrypted only inside `packages/decathlon`, never logged (even
  in debug mode — mask in `packages/logger`).
- No webhook signature verification needed on the Decathlon side (no webhooks exist); all Decathlon
  communication is outbound polling/push initiated by this app, authenticated by the stored API key.
- Shopify webhook HMAC verification required for all inbound Shopify webhooks per standard practice.
