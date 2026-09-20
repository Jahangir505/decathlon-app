import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

/** Singleton PrismaClient — one connection pool per process (backend, worker each get their own). */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return prisma;
}

export type { PrismaClient } from "@prisma/client";
export * from "@prisma/client";
