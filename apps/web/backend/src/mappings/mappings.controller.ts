import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { SessionTokenGuard, type AuthenticatedRequest } from "../auth/session-token.guard";
import { BadRequestException } from "@nestjs/common";
import { MappingsService, type MappingKind } from "./mappings.service";

const KINDS: MappingKind[] = ["brand", "color", "size"];
function kindOf(kind: string): MappingKind {
  if (!KINDS.includes(kind as MappingKind)) throw new BadRequestException(`kind must be one of ${KINDS.join(", ")}`);
  return kind as MappingKind;
}

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

  @Get("shopify/untyped-products")
  untypedProducts(@Req() req: AuthenticatedRequest) {
    return this.mappings.untypedProducts(req.shopId);
  }

  @Post("shopify/product-type")
  setProductType(@Req() req: AuthenticatedRequest, @Body() body: { productIds: string[]; productType: string }) {
    return this.mappings.setProductType(req.shopId, body?.productIds, body?.productType);
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

  // ── Brand / colour / size (Shopify vendor or option value -> Decathlon value) ─────────────────

  @Get("kind/:kind")
  kindValues(@Req() req: AuthenticatedRequest, @Param("kind") kind: string) {
    return this.mappings.optionValues(req.shopId, kindOf(kind));
  }

  @Post("kind/:kind")
  saveKind(
    @Req() req: AuthenticatedRequest,
    @Param("kind") kind: string,
    @Body() body: { shopifyValue: string; decathlonCode: string; decathlonLabel?: string },
  ) {
    return this.mappings.saveKindMapping(req.shopId, kindOf(kind), body.shopifyValue, body.decathlonCode, body.decathlonLabel);
  }

  @Post("kind/:kind/confirm-all")
  confirmAll(@Req() req: AuthenticatedRequest, @Param("kind") kind: string) {
    const k = kindOf(kind);
    if (k === "size") throw new BadRequestException("Sizes resolve through each product type's size chart — set a chart instead");
    return this.mappings.confirmAllExact(req.shopId, k);
  }

  @Get("reference/genders")
  genders(@Req() req: AuthenticatedRequest) {
    return this.mappings.genders(req.shopId);
  }

  @Get("reference/size-charts")
  sizeCharts(@Req() req: AuthenticatedRequest, @Query("q") q?: string) {
    return this.mappings.sizeCharts(req.shopId, q ?? "");
  }

  @Post("categories/details")
  saveTypeDetails(
    @Req() req: AuthenticatedRequest,
    @Body() body: { productType: string; gender?: string | null; sizeChart?: string | null },
  ) {
    return this.mappings.saveTypeDetails(req.shopId, body.productType, { gender: body.gender, sizeChart: body.sizeChart });
  }

  @Get("readiness")
  readiness(@Req() req: AuthenticatedRequest) {
    return this.mappings.readiness(req.shopId);
  }

  @Delete("kind/:kind")
  deleteKind(@Req() req: AuthenticatedRequest, @Param("kind") kind: string, @Query("shopifyValue") shopifyValue: string) {
    return this.mappings.deleteKindMapping(req.shopId, kindOf(kind), shopifyValue);
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
