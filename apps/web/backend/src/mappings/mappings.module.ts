import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MappingsController } from "./mappings.controller";
import { MappingsService } from "./mappings.service";

@Module({
  imports: [AuthModule],
  controllers: [MappingsController],
  providers: [MappingsService],
})
export class MappingsModule {}
