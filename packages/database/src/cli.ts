import { createDb } from './client';
import { runMigrations } from './migrate';
import { seedSystemRoles } from './seed';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL (migrator credentials) or DATABASE_URL is required');

  if (cmd === 'migrate') {
    const applied = await runMigrations(url);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
  } else if (cmd === 'seed') {
    const db = createDb(url, { max: 2 });
    try {
      await seedSystemRoles(db);
      console.log('Seeded system roles and permissions');
    } finally {
      await db.destroy();
    }
  } else {
    throw new Error('Usage: cli.ts <migrate|seed>');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
