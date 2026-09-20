import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import type { Repositories } from "@shopify-decathlon/database";
import { SessionTokenGuard, type AuthenticatedRequest } from "../auth/session-token.guard";
import { REPOSITORIES } from "../database/database.module";

@Controller("api/logs")
@UseGuards(SessionTokenGuard)
export class LogsController {
  constructor(@Inject(REPOSITORIES) private readonly repositories: Repositories) {}

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query("skip") skip?: string, @Query("take") take?: string) {
    const opts = { skip: skip ? Number(skip) : undefined, take: take ? Number(take) : undefined };
    const [items, total] = await Promise.all([
      this.repositories.syncLogs.list(req.shopId, opts),
      this.repositories.syncLogs.count(req.shopId),
    ]);
    return { items, total };
  }
}
