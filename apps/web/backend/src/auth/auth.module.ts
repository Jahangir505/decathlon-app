import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionTokenGuard } from "./session-token.guard";

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionTokenGuard],
  exports: [AuthService, SessionTokenGuard],
})
export class AuthModule {}
