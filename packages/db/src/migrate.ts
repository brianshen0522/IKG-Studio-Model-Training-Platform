import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import pg from "pg";

const MIGRATIONS_DIR = resolve(__dirname, "../../../database/migrations");

const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  database: process.env.POSTGRES_DB || "model_trainer",
  user: process.env.POSTGRES_MIGRATION_USER,
  password: process.env.POSTGRES_MIGRATION_PASSWORD,
  max: 1,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS app");

    await client.query(`
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query(
      "SELECT version FROM app.schema_migrations ORDER BY version"
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`Applying: ${file}`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO app.schema_migrations (version) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  OK`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED: ${file}`);
        throw err;
      }
    }

    console.log("All migrations applied");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
