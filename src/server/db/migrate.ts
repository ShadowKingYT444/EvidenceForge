import { promises as fs } from "node:fs";
import path from "node:path";
import type { PgPoolLike } from "../workflow/postgres-store";

export async function runMigrations(pool: PgPoolLike, directory = path.resolve(process.cwd(), "migrations")): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const filename of files) {
    const existing = await pool.query<{ filename: string }>(`SELECT filename FROM schema_migrations WHERE filename = $1`, [filename]);
    if (existing.rows.length) continue;
    const sql = await fs.readFile(path.join(directory, filename), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
