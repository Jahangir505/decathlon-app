import { Body, Controller, Delete, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { SessionTokenGuard, type AuthenticatedRequest } from "../auth/session-token.guard";
import { MappingsService } from "./mappings.service";

@Controller("api/mappings")
@UseGuards(SessionTokenGuard)
export class MappingsController {
  constructor(private readonly mappings: MappingsService) {}

  // ── Decathlon reference data (read-only, cached) ────────────────────────────────────────────

  @Get("reference/categories")
  searchCategories(@Req() req: AuthenticatedRequest, @Query("q") q?: string, @Query("limit") limit?: string) {
    return this.mappings.searchCategories(req.shopId, q ?? "", limit ? Number(limit) : undefined);
  }

  @Get("reference/attributes")
  categoryAttributes(@Req() req: AuthenticatedRequest, @Query("categoryCode") categoryCode: string) {
    return this.mappings.categoryAttributes(req.shopId, categoryCode);
  }

  @Get("reference/values")
  searchValues(
    @Req() req: AuthenticatedRequest,
    @Query("listCode") listCode: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ) {
    return this.mappings.searchValues(req.shopId, listCode, q ?? "", limit ? Number(limit) : undefined);
  }

  // ── Shopify side ────────────────────────────────────────────────────────────────────────────

  @Get("shopify/product-types")
  productTypes(@Req() req: AuthenticatedRequest) {
    return this.mappings.shopifyProductTypes(req.shopId);
  }

  // ── Category rules ──────────────────────────────────────────────────────────────────────────

  @Get("categories")
  listCategories(@Req() req: AuthenticatedRequest) {
    return this.mappings.listCategoryMappings(req.shopId);
  }

  @Post("categories")
  saveCategory(
    @Req() req: AuthenticatedRequest,
    @Body() body: { productType: string; categoryCode: string; categoryLabel?: string },
  ) {
    return this.mappings.saveCategoryMapping(req.shopId, body.productType, body.categoryCode, body.categoryLabel);
  }

  @Delete("categories")
  deleteCategory(@Req() req: AuthenticatedRequest, @Query("productType") productType: string) {
    return this.mappings.deleteCategoryMapping(req.shopId, productType);
  }

  // ── Attribute value rules (colour, and any other LIST attribute a category requires) ────────

  @Get("values")
  listValues(@Req() req: AuthenticatedRequest, @Query("attributeCode") attributeCode?: string) {
    return this.mappings.listValueMappings(req.shopId, attributeCode);
  }

  @Post("values")
  saveValue(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: { attributeCode: string; valuesListCode: string; shopifyValue: string; decathlonCode: string; decathlonLabel?: string },
  ) {
    return this.mappings.saveValueMapping(req.shopId, body);
  }

  @Delete("values")
  deleteValue(
    @Req() req: AuthenticatedRequest,
    @Query("attributeCode") attributeCode: string,
    @Query("shopifyValue") shopifyValue: string,
  ) {
    return this.mappings.deleteValueMapping(req.shopId, attributeCode, shopifyValue);
  }
}
