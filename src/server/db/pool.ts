import { createRequire } from "node:module";
import type { PgPoolLike } from "../workflow/postgres-store";

export type ProductionPool = PgPoolLike & { end?: () => Promise<void> };

/** Construct the production pg pool lazily, keeping tests independent of pg. */
export function createProductionPool(connectionString = process.env.DATABASE_URL): ProductionPool {
  if (!connectionString) throw new Error("DATABASE_URL is required for durable storage");
  const require = createRequire(import.meta.url);
  const pg = require("pg") as { Pool: new (options: Record<string, unknown>) => ProductionPool };
  return new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
}
