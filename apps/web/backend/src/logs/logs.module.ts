import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LogsController } from "./logs.controller";

@Module({
  imports: [AuthModule],
  controllers: [LogsController],
})
export class LogsModule {}
