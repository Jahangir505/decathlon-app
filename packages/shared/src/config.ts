import { z } from "zod";

/**
 * Every process (backend, worker) loads env through this schema so a missing/malformed
 * variable fails fast at boot instead of surfacing as a confusing runtime error later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  SHOPIFY_API_KEY: z.string().min(1, "SHOPIFY_API_KEY is required"),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SHOPIFY_SCOPES: z.string().min(1, "SHOPIFY_SCOPES is required"),
  SHOPIFY_APP_URL: z.string().url("SHOPIFY_APP_URL must be a valid URL"),
  SHOPIFY_API_VERSION: z.string().min(1).default("2025-01"),

  DECATHLON_API_VERSION: z.string().default("v1"),

  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters (used as AES-256-GCM key material)"),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | undefined;

/** Parses and validates process.env once per process; throws with a readable message on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export function shopifyScopesArray(env: Pick<AppEnv, "SHOPIFY_SCOPES">): string[] {
  return env.SHOPIFY_SCOPES.split(",").map((s) => s.trim()).filter(Boolean);
}
