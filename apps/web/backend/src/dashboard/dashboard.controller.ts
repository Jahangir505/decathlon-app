import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { SessionTokenGuard, type AuthenticatedRequest } from "../auth/session-token.guard";
import { DashboardService } from "./dashboard.service";

@Controller("api/dashboard")
@UseGuards(SessionTokenGuard)
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get("summary")
  getSummary(@Req() req: AuthenticatedRequest) {
    return this.service.getSummary(req.shopId);
  }
}
