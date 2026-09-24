# Backend API + the built embedded frontend (served by ServeStaticModule) in one process.
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm prisma:generate
# Vite inlines this at build time — the embedded app can't load App Bridge without it.
ARG VITE_SHOPIFY_API_KEY
ENV VITE_SHOPIFY_API_KEY=$VITE_SHOPIFY_API_KEY
RUN test -n "$VITE_SHOPIFY_API_KEY" || (echo "VITE_SHOPIFY_API_KEY build arg is required" && exit 1)
# The trailing "..." also builds every workspace package the backend depends on (they load from dist/).
RUN pnpm --filter "@shopify-decathlon/backend..." --filter @shopify-decathlon/frontend build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 8080
# Migrations run on every start; `migrate deploy` is a no-op when there's nothing new to apply.
CMD ["sh", "-c", "pnpm prisma:deploy && node apps/web/backend/dist/main.js"]
