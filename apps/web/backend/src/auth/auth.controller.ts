import { BadRequestException, Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { isValidShopDomain } from "@shopify-decathlon/shopify";
import { AuthService } from "./auth.service";

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Entry point Shopify redirects a merchant to when the app isn't installed yet (classic OAuth
   * begin). See docs/architecture.md — kept alongside token exchange for a well-understood, proven
   * install path.
   */
  @Get()
  begin(@Query("shop") shop: string, @Res() res: Response) {
    if (!shop || !isValidShopDomain(shop)) {
      throw new BadRequestException("Missing or invalid shop parameter");
    }
    return res.redirect(this.authService.buildInstallRedirectUrl(shop));
  }

  @Get("callback")
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const { shop, code } = query;
    if (!shop || !isValidShopDomain(shop) || !code) {
      throw new BadRequestException("Missing shop or code parameter");
    }
    if (!this.authService.verifyCallbackHmac(query)) {
      throw new BadRequestException("Invalid HMAC signature");
    }
    if (!query.state || !this.authService.verifyState(query.state, shop)) {
      throw new BadRequestException("Invalid state parameter");
    }

    await this.authService.completeInstall(shop, code);

    // Hand off to the embedded app inside Shopify admin.
    return res.redirect(`https://${shop}/admin/apps`);
  }

  /**
   * Called by the frontend on every embedded load (App Bridge gives it a fresh session token) to
   * keep the stored offline access token current via Token Exchange. See packages/shopify/token-exchange.ts.
   */
  @Post("session")
  async session(@Body("sessionToken") sessionToken: string) {
    if (!sessionToken) {
      throw new BadRequestException("Missing sessionToken");
    }
    const result = await this.authService.syncFromSessionToken(sessionToken);
    return { ok: true, ...result };
  }
}
