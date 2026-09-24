import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
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

  @Post("complete-setup")
  completeSetup(@Req() req: AuthenticatedRequest) {
    return this.service.completeSetup(req.shopId);
  }

  @Post("sync-products-now")
  syncProductsNow(@Req() req: AuthenticatedRequest) {
    return this.service.syncProductsNow(req.shopId);
  }

  @Get("selected-products")
  listSelectedProducts(@Req() req: AuthenticatedRequest) {
    return this.service.listSelectedProducts(req.shopId);
  }

  @Post("selected-products")
  addSelectedProducts(
    @Req() req: AuthenticatedRequest,
    @Body() body: { products: Array<{ shopifyProductId: string; title: string }> },
  ) {
    return this.service.addSelectedProducts(req.shopId, body?.products);
  }

  /** Takes the numeric id: a gid's slashes don't survive as a single path segment. */
  @Delete("selected-products/:productId")
  async removeSelectedProduct(@Req() req: AuthenticatedRequest, @Param("productId") productId: string) {
    await this.service.removeSelectedProduct(req.shopId, `gid://shopify/Product/${productId}`);
    return { removed: true };
  }
}
