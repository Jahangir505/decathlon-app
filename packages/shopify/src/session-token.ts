import jwt from "jsonwebtoken";

export interface DecodedSessionToken {
  iss: string; // https://{shop}/admin
  dest: string; // https://{shop}
  aud: string; // API key
  sub: string; // Shopify user id
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid: string;
}

/**
 * Verifies an App Bridge session token (JWT, HS256 signed with the app's API secret).
 * See shopify.dev "Session token" docs. Throws on invalid signature, expiry, or audience mismatch.
 */
export function verifySessionToken(token: string, apiKey: string, apiSecret: string): DecodedSessionToken {
  const decoded = jwt.verify(token, apiSecret, { algorithms: ["HS256"] }) as DecodedSessionToken;

  if (decoded.aud !== apiKey) {
    throw new Error("Session token audience does not match this app's API key");
  }

  return decoded;
}

/** Extracts the shop domain (e.g. my-store.myshopify.com) from a verified session token's `dest` claim. */
export function shopDomainFromSessionToken(decoded: DecodedSessionToken): string {
  return new URL(decoded.dest).hostname;
}
