import { createDb, type Database } from '@model-trainer/db';
import { Kysely } from 'kysely';
import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';

async function main() {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!username || !password) {
    console.error('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be set');
    process.exit(1);
  }

  const { db, pool } = createDb({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });

  try {
    const existing = await db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'ADMIN')
      .limit(1)
      .executeTakeFirst();

    if (existing) {
      console.log('Admin user already exists, skipping bootstrap');
      return;
    }

    // No length or complexity rules by project decision — see PasswordService.validatePolicy.

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const result = await db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('users')
        .values({
          username,
          display_name: 'System Admin',
          password_hash: passwordHash,
          role: 'ADMIN',
          status: 'ACTIVE',
          must_change_password: false,
        })
        .returning(['id', 'username', 'role', 'status', 'created_at'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('audit_logs')
        .values({
          actor_type: 'SYSTEM',
          actor_ref: 'bootstrap',
          action_code: 'USER_CREATED',
          resource_type_code: 'USER',
          resource_id: user.id,
          result: 'SUCCESS',
          metadata: { username: user.username, role: user.role, method: 'bootstrap' },
          after_snapshot: {
            id: user.id,
            username: user.username,
            display_name: 'System Admin',
            role: user.role,
            status: user.status,
            must_change_password: false,
          },
        })
        .execute();

      return user;
    });

    console.log(`Admin user created: ${result.username} (${result.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Bootstrap failed:', err.message);
  process.exit(1);
});
