import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { DecathlonConnectionController } from "./decathlon-connection.controller";
import { DecathlonConnectionService } from "./decathlon-connection.service";

@Module({
  imports: [AuthModule, SchedulerModule],
  controllers: [DecathlonConnectionController],
  providers: [DecathlonConnectionService],
})
export class DecathlonConnectionModule {}
