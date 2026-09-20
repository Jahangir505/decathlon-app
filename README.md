# Shopify ↔ Decathlon Partner Integration

Status: **Phases 1-6 implemented and building cleanly.** Product sync (Shopify → Decathlon `P41`),
offer sync (`OF01`/`OF24`), and order import (Decathlon → Shopify `OR11`) are fully implemented —
matching logic, adapters, the BullMQ producer/scheduler, webhook-triggered auto-sync, and a settings
UI to turn it on. **Multipart/form-data support for `P41`/`OF01` is now built** (CSV file upload,
`file` form field — confirmed live against the preprod sandbox, no more `415`), and the product-import
row builder now auto-maps the 6 Decathlon attributes confirmed globally required (brand, EAN, main
image, product identifier, GPSR manufacturer email) by consulting PM11/VL11, throwing a clear error
naming exactly what's missing for anything it can't safely auto-map (mainly per-category size/type
attributes, which need Decathlon's own controlled values, not Shopify's free-text options). The order
import currency bug from earlier is also fixed and confirmed live. See `docs/api-mapping.md` §4 items
7-8 for the full write-up. Fulfillment/refund push-back (`OR23`/`OR24`/`OR28`) remains deferred —
`packages/sync/src/engine.ts`'s `syncFulfillment`/`syncRefund` are still stubs.

**2026-09-20 — import result reporting rebuilt (§4 item 10).** Product syncs used to sit on
`PROCESSING` forever and, had they resolved, would have reported failures as successes. Four causes,
all confirmed live: the poll job re-queued itself under a BullMQ job id that already existed (so it
was silently dropped after one check and never ran again); a product import has **two** stages and
only the first was being read; the integration error report was fetched from a path that 404s
(`error-report`, vs the real `error_report`); and the reports' `warnings` column — which is where a
refused title actually explains itself — was discarded. Sync Logs now also name the product each row
is about. **The remaining blocker is Decathlon-side — see "Still open".**

## Phase 1 deliverables (architecture & design)

- [docs/api-mapping.md](docs/api-mapping.md) — every Decathlon (Mirakl) API endpoint confirmed so far,
  what it's used for, and what's still unconfirmed. **Read this first** — it documents a key finding:
  Decathlon Partner is a Mirakl marketplace, so the Shopify merchant is a *seller on* Decathlon, not an
  importer of Decathlon's catalogue.
- [docs/architecture.md](docs/architecture.md) — tech stack, layered architecture, monorepo layout,
  data flow diagrams.
- [docs/database-design.md](docs/database-design.md) — ERD and rationale.
- [docs/sync-strategy.md](docs/sync-strategy.md) — matching priority, idempotency, retry/backoff,
  polling schedule, pricing rules, open items.

## Phase 2: what's built

- **Monorepo**: pnpm workspaces — `packages/shared`, `packages/logger`, `packages/database`,
  `packages/decathlon`, `packages/shopify`, `packages/sync`, `apps/web/backend` (NestJS),
  `apps/web/frontend` (React/Vite/Polaris), `worker/` (BullMQ). All packages build and type-check.
- **Database**: [prisma/schema.prisma](prisma/schema.prisma), Prisma client generates successfully.
- **Shopify auth**: classic OAuth install flow (`/api/auth`, `/api/auth/callback`) for first install,
  plus **Token Exchange** (`/api/auth/session`) — the current Shopify-recommended flow for embedded
  apps — used on every embedded page load to keep the stored offline token fresh. Embedded API routes
  are protected by `SessionTokenGuard`, which verifies the App Bridge session token (JWT) on every
  request and resolves it to a tenant-scoped `shopId`.
- **Decathlon connection**: `DecathlonClient` (packages/decathlon) implementing every endpoint in
  `docs/api-mapping.md` with retry/backoff/rate-limit handling; a "Test Connection" UI page and API
  route that exercises it for real.
- **Basic UI**: Polaris-based Dashboard, Decathlon Connection, and Sync Logs pages, embedded via
  App Bridge.
- **Security**: Decathlon API keys and Shopify access tokens are AES-256-GCM encrypted at rest
  (`packages/shared/src/crypto.ts`); secrets are masked before any log/DB write
  (`packages/logger/src/mask.ts`); webhook HMAC verification; every query is shop-scoped.

## Getting started

1. Copy `.env.example` to `.env` and fill in:
   - A Shopify Partner app's `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` (create one with
     `shopify app config link`, matching `shopify.app.toml`).
   - `ENCRYPTION_KEY` — any random 32+ character string for local dev.
   - Leave `DECATHLON_API_BASE_URL` as-is (preprod) — the actual per-shop key is entered in-app via
     the Connect Decathlon page, not an env var (it's multi-tenant, stored encrypted per shop).
2. `docker compose up -d postgres redis`
3. `pnpm install`
4. `pnpm prisma:migrate` — creates the database schema.
5. `pnpm dev:backend` (NestJS on :8080) and, separately, `pnpm dev:frontend` (Vite on :5173) — or run
   `shopify app dev` once `shopify.app.toml`'s `client_id` is linked, which tunnels and reloads both.
6. `pnpm dev:worker` — starts the BullMQ worker (its jobs are stubs until Phase 4+).

## Phase 4-6: what's built

- **`packages/sync`**: `SyncEngine.syncProduct`/`syncOffers`/`importOrders`/`pollImportStatus` are
  real implementations (matching priority, idempotency, PM11 attribute caching, offset-cursor
  pagination) — see `docs/sync-strategy.md` for the rules they follow. `syncFulfillment`/`syncRefund`
  remain stubs (deferred scope).
- **Producer + scheduler** (`apps/web/backend/src/scheduler`): this didn't exist at all before — the
  worker had queues to consume but nothing ever added a job. `QueueProducerService` now enqueues
  product/offer sync with deterministic job IDs (so duplicate webhook bursts coalesce), and
  `OrderImportSchedulerService` keeps a per-shop BullMQ repeatable job in sync with each shop's
  `SyncConfiguration` (reconciles on a 5-min sweep, and immediately after settings changes).
- **Webhook-triggered sync**: `products/update` and `inventory_levels/update` now enqueue real jobs,
  gated by per-shop toggles (off by default) — see the "Automatic sync" card on the Connect Decathlon
  page, backed by `GET`/`POST /api/sync-configuration`.
- **Multipart + attribute mapping**: `P41`/`OF01` multipart upload built and confirmed live 2026-09-18
  (see `docs/api-mapping.md` §4 item 8). Product rows now auto-populate every globally-required PM11
  attribute; category-specific attributes (mostly per-category size/type value lists) still need
  manual mapping and raise a clear error naming what's missing rather than guessing.

## Mappings (2026-09-20)

A **Mappings** page replaces hand-typing Decathlon codes into per-product metafields:

- **Product type → Decathlon category.** Set once per Shopify product type; every product of that
  type inherits it. A product's own `custom.decathlon_category` metafield still overrides the rule,
  and "Sync products now" treats a product as eligible if *either* applies. The category picker
  searches the H11 tree, shows the full root-to-leaf path, and flags the retired
  **"DO NOT USE"** categories — H11 mixes several trees and a naive apparel search surfaces the dead
  ones first.
- **Option value → Decathlon value.** For attributes whose values Decathlon controls (a `LIST` with a
  VL11 list). An explicit mapping always beats the existing name/label matching, which can silently
  pick a wrong-but-similar entry.
- **Honest per category.** The page asks Decathlon which attributes a category actually requires
  (PM11 + inherited ancestors) and splits them into *automatic* (the app already fills them),
  *mappable* (bind your values), and *needs a value per product* (free text → the
  `custom.decathlon_attributes` metafield).

**There is no global size list.** Sizes are 464 separate per-category `SIZE_CPN_*` lists, and **no
category under `100000 Apparel, Footwear, Accessories` declares a size attribute at all** — for
`128500` (T-shirts) the only category attribute is `color`. Variant sizes therefore identify the
variant (its own `shop_sku` + EAN) rather than becoming an attribute, which is how the seller's 47
existing live T-shirt offers are already structured. Categories that *do* carry `SIZE_CPN_*` lists
are mostly in the retired trees; the mapping UI handles them automatically if one is ever chosen,
since it drives off the category's real attribute list rather than a hardcoded size/colour form.

Reference data is cached per shop in `DecathlonCatalogReference` and fetched **on demand**: H11 and
PM11 wholesale (they ignore their filters), VL11 one list at a time (unfiltered it returns
gigabytes). Shared by the sync engine and the mapping screens via `CatalogCache`.

## Endpoint sweep + first successful write (2026-09-20)

Every endpoint in Decathlon's own documented list was called against preprod. **Four documented
paths do not exist on this instance** (`docs/api-mapping.md` §4 item 11), and two were silently
breaking the integration:

- **OF03's real path is `/error_report`, not `/error-report`** — the same hyphen/underscore trap as
  P44. Every offer-import failure had therefore been reported with no detail, which is also the real
  explanation for the "OF03 eventual-consistency delay" noted previously: the report was always
  there, the URL was wrong. Rule for this instance: report sub-resources are underscored.
- **`state_code` is mandatory on every offer and was never being sent.** The now-readable report
  says `The state of the product is unknown`. Adding `state_code: "11"` (New — what all 100 live
  offers use) turned a failing push into `lines_in_success: 1, offer_inserted: 1, COMPLETE`: **the
  first successful write this integration has made.** Configurable via
  `SyncConfiguration.offerStateCode`, because OF61 (which would list the alternatives) 404s.
- **Offers attach to a catalogue product by `product_id` + `product_id_type: "EAN"`**, now sent
  whenever a variant has a barcode. Worth knowing: a variant whose EAN already exists in Decathlon's
  catalogue can be made sellable through OF24 alone — **no P41 product import, so the title blocker
  below does not apply to it.**
- P45 (`/report`) and OF61 (`/api/offers/conditions`) 404 with no working variant found.

**OF01 (bulk offer import) had never worked either** — three separate causes, all fixed
(`docs/api-mapping.md` §4 item 12). OF24 (JSON) and OF01 (CSV) are two wire formats for the same
data and this app was sending OF24's field names to both: `import_mode` is a required form field
(without it OF01 `400`s before reading a row), the CSV columns are hyphenated and differently named
(`shop_sku`→`sku`, `state_code`→`state`, and there is **no currency column**), and `state` takes the
numeric code `11` — *not* the label `New` from Decathlon's published value list, which is rejected.
Verified by submitting both in one file: the `11` row inserted, the `New` row failed.

## Still open

- **The one real blocker: Decathlon refuses `productTitle-en_GB` for category `128500`.** Every row
  that now transforms cleanly still comes back with
  `2021|The attribute 'productTitle-en_GB' (Product Title en-GB) does not comply with script validation because: DEBUG category=128500.`
  and is then refused by the integration stage (`MCM-04020|The product has been deleted.`), so
  **nothing has ever reached `products_successfully_synchronized > 0`**. This is not something the app
  can fix by sending different data: four deliberately different title styles were submitted under
  fresh SKUs (import 26741) and all four produced the identical warning, whose message is a literal
  `DEBUG` string. **This needs a question to Decathlon's onboarder.** See `docs/api-mapping.md` §4
  item 10. (One real rule did come out of that test and is now enforced: `productTitle-*` is capped at
  80 characters.)
- **Product publish is unblocked as of 2026-09-18** — the `1004|The category could not be identified`
  wall every attempt hit was P41's `operator_format` flag (now always sent), and the real per-attribute
  report lives at `.../imports/{id}/transformation_error_report`. Remaining per-product requirements
  now surface as clear Sync Log errors naming exactly what to fix: a valid EAN (check digit verified
  client-side), a recognized brand (or the "Fallback brand" setting), the GPSR email setting, and —
  for anything Shopify has no field for, like the required sport (`SPORT_ALL`, inherited from the
  category tree) or a category's own size/color/type lists — values set on the product's
  **"Decathlon Attributes"** metafield (`custom.decathlon_attributes`, JSON of attribute code → value,
  matched against Decathlon's own lists). See `docs/api-mapping.md` §4 item 9.
- ~~**Not yet seen: a product reaching Decathlon's downstream import stage**~~ — **resolved
  2026-09-20**: that stage reports through an `integration_details` object which appears *after*
  `import_status` already reads `COMPLETE`, and its errors live at the underscored
  `/imports/{id}/error_report` (the hyphenated `error-report` this app used 404s unconditionally,
  which is why it looked like a report products never have). A clean transformation is NOT a
  published product — import 26737 had 0 transform errors and `rejected_products: 4`. See
  `docs/api-mapping.md` §4 item 10.
- Real `OR11` (order) response shape is now confirmed live (see the order-import currency-bug fix).
- Fulfillment/refund push-back (`OR23`/`OR24`/`OR28`) — deferred, not yet designed in detail.
- `OF61` 404 and `RT30`/`RT31` 403/`RT12` 400 — see `docs/api-mapping.md` §4 item 5, worth a question
  to Decathlon's onboarder. (`VL11`'s 404 is resolved — see item 8, it just needed the generic Mirakl
  path instead of the Zendesk-guide one.)
