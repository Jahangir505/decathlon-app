import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { SessionTokenGuard, type AuthenticatedRequest } from "../auth/session-token.guard";
import { SyncConfigurationService, type UpdateSyncConfigurationInput } from "./sync-configuration.service";

@Controller("api/sync-configuration")
@UseGuards(SessionTokenGuard)
export class SyncConfigurationController {
  constructor(private readonly service: SyncConfigurationService) {}

  @Get()
  get(@Req() req: AuthenticatedRequest) {
    return this.service.get(req.shopId);
  }

  @Post()
  update(@Req() req: AuthenticatedRequest, @Body() body: UpdateSyncConfigurationInput) {
    return this.service.update(req.shopId, body);
  }

  @Post("sync-now")
  syncNow(@Req() req: AuthenticatedRequest) {
    return this.service.syncOrdersNow(req.shopId);
  }

  @Post("sync-products-now")
  syncProductsNow(@Req() req: AuthenticatedRequest) {
    return this.service.syncProductsNow(req.shopId);
  }
}
