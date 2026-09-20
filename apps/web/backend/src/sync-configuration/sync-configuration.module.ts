import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { SyncConfigurationController } from "./sync-configuration.controller";
import { SyncConfigurationService } from "./sync-configuration.service";

@Module({
  imports: [AuthModule, SchedulerModule],
  controllers: [SyncConfigurationController],
  providers: [SyncConfigurationService],
})
export class SyncConfigurationModule {}
