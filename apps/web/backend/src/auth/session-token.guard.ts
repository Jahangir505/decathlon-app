import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { REPOSITORIES } from "../database/database.module";
import type { Repositories } from "@shopify-decathlon/database";

export interface AuthenticatedRequest extends Request {
  shopId: string;
  shopDomain: string;
}

/**
 * Protects every embedded-app API route: requires a valid App Bridge session token in the
 * Authorization header, resolves it to this app's internal Shop row, and attaches shopId/shopDomain
 * to the request so every downstream handler/repository call is tenant-scoped (requirement §25).
 */
@Injectable()
export class SessionTokenGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    @Inject(REPOSITORIES) private readonly repositories: Repositories,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing session token");
    }

    const token = header.slice("Bearer ".length);

    let shopDomain: string;
    try {
      ({ shopDomain } = this.authService.verifyEmbeddedRequestToken(token));
    } catch {
      throw new UnauthorizedException("Invalid or expired session token");
    }

    const shop = await this.repositories.shops.findByDomain(shopDomain);
    if (!shop || !shop.isActive) {
      throw new UnauthorizedException("Shop not installed");
    }

    request.shopId = shop.id;
    request.shopDomain = shopDomain;
    return true;
  }
}
