FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY worker ./worker
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @shopify-decathlon/database prisma:generate || true
RUN pnpm --filter @shopify-decathlon/worker build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/worker
CMD ["node", "dist/index.js"]
