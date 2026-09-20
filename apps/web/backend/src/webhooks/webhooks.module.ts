import { Module } from "@nestjs/common";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [SchedulerModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
