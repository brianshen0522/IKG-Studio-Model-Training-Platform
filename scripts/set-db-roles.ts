/**
 * Sets the LOGIN passwords for the per-service database roles at deploy time.
 *
 * Migration 034 creates backend_role / worker_role / scheduler_role / readonly_role
 * as LOGIN roles WITHOUT passwords (doc 18: no hardcoded passwords in migrations).
 * This script injects them from the environment, connecting as the migration role.
 * It is idempotent — safe to run on every deploy.
 */
import pg from 'pg';

// Role -> env var holding its password. Role names are constants (never user input).
const ROLE_PASSWORD_ENV: Array<{ role: string; envKey: string; required: boolean }> = [
  { role: 'backend_role', envKey: 'BACKEND_DB_PASSWORD', required: true },
  { role: 'worker_role', envKey: 'WORKER_DB_PASSWORD', required: true },
  { role: 'scheduler_role', envKey: 'SCHEDULER_DB_PASSWORD', required: true },
  { role: 'readonly_role', envKey: 'READONLY_DB_PASSWORD', required: false },
];

// Escape single quotes for a SQL string literal (ALTER ROLE ... PASSWORD cannot be parameterised).
function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'model_trainer',
    user: process.env.POSTGRES_MIGRATION_USER,
    password: process.env.POSTGRES_MIGRATION_PASSWORD,
    max: 1,
  });

  const client = await pool.connect();
  try {
    for (const { role, envKey, required } of ROLE_PASSWORD_ENV) {
      const pw = process.env[envKey];
      if (!pw) {
        if (required) {
          console.error(`${envKey} must be set (password for ${role})`);
          process.exit(1);
        }
        console.log(`Skipping ${role} (${envKey} not set)`);
        continue;
      }
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${sqlLiteral(pw)}`);
      console.log(`Set password for ${role}`);
    }
    console.log('Database role passwords set');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
