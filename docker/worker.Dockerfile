# BullMQ worker — no HTTP port. Migrations are applied by the backend service, not here.
FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
RUN corepack enable

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm prisma:generate
RUN pnpm --filter "@shopify-decathlon/worker..." build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
CMD ["node", "worker/dist/index.js"]
