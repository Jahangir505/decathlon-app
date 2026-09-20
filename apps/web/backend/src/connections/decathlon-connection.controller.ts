import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { SessionTokenGuard } from "../auth/session-token.guard";
import type { AuthenticatedRequest } from "../auth/session-token.guard";
import { DecathlonConnectionService, type SaveConnectionInput } from "./decathlon-connection.service";

@Controller("api/connections/decathlon")
@UseGuards(SessionTokenGuard)
export class DecathlonConnectionController {
  constructor(private readonly service: DecathlonConnectionService) {}

  @Get()
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.service.getStatus(req.shopId);
  }

  @Post()
  save(@Req() req: AuthenticatedRequest, @Body() body: SaveConnectionInput) {
    return this.service.save(req.shopId, body);
  }

  @Post("test")
  test(@Req() req: AuthenticatedRequest) {
    return this.service.testConnection(req.shopId);
  }
}
