FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/web/backend ./apps/web/backend
COPY apps/web/frontend ./apps/web/frontend
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @shopify-decathlon/database prisma:generate || true
RUN pnpm --filter @shopify-decathlon/frontend build
RUN pnpm --filter @shopify-decathlon/backend build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/web/backend
EXPOSE 8080
CMD ["node", "dist/main.js"]
