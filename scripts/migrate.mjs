import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required for migrations");
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const pool = new Pool({ connectionString: url, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const dir = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const { rows } = await pool.query("SELECT filename FROM schema_migrations WHERE filename = $1", [file]);
    if (rows.length) continue;
    await pool.query("BEGIN");
    try {
      await pool.query(await readFile(path.join(dir, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await pool.end();
}
