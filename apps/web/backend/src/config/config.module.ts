import { Global, Module } from "@nestjs/common";
import { loadEnv, type AppEnv } from "@shopify-decathlon/shared";
import { createLogger, type Logger } from "@shopify-decathlon/logger";

export const APP_ENV = Symbol("APP_ENV");
export const APP_LOGGER = Symbol("APP_LOGGER");

@Global()
@Module({
  providers: [
    { provide: APP_ENV, useFactory: (): AppEnv => loadEnv() },
    { provide: APP_LOGGER, useFactory: (): Logger => createLogger("backend") },
  ],
  exports: [APP_ENV, APP_LOGGER],
})
export class ConfigModule {}
