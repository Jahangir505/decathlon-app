import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health/health.controller";
import { DecathlonConnectionModule } from "./connections/decathlon-connection.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { LogsModule } from "./logs/logs.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { SyncConfigurationModule } from "./sync-configuration/sync-configuration.module";
import { MappingsModule } from "./mappings/mappings.module";

@Module({
  imports: [
    // Serves the built frontend (apps/web/frontend/dist) in production so the embedded app is a
    // single deployable process; in development the Vite dev server (port 5173) is used instead.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, "..", "..", "frontend", "dist"),
      exclude: ["/api*"],
    }),
    ConfigModule,
    DatabaseModule,
    AuthModule,
    DecathlonConnectionModule,
    DashboardModule,
    WebhooksModule,
    LogsModule,
    SchedulerModule,
    SyncConfigurationModule,
    MappingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
