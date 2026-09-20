import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// The monorepo's single .env lives at the repo root, four levels up from this file's compiled
// location (apps/web/backend/dist/main.js) — must run before AppModule's providers read process.env.
loadDotenv({ path: resolve(__dirname, "../../../../.env") });

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import * as express from "express";
import { AppModule } from "./app.module";
import { loadEnv } from "@shopify-decathlon/shared";
import { createLogger } from "@shopify-decathlon/logger";

async function bootstrap() {
  const env = loadEnv();
  const logger = createLogger("backend");

  // bodyParser disabled at Nest level so we can capture the raw body for Shopify webhook HMAC
  // verification (packages/shopify/src/webhooks.ts) before JSON parsing.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.enableCors({ origin: true, credentials: true });

  // Embedded apps are framed by Shopify admin — CSP must allow it (requirement §24).
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors https://*.myshopify.com https://admin.shopify.com;");
    next();
  });

  await app.listen(env.PORT);
  logger.info({ event: "backend_started", port: env.PORT });
}

bootstrap();
