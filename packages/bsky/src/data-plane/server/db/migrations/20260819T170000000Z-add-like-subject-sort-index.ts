import { type Kysely, sql } from 'kysely'

// Eurosky: left to the operator. Upstream builds this index at boot with a
// plain CREATE INDEX. On juice's like table (17.8B rows) that takes hours,
// blocks every like write the whole time and needs ~2.7 TB of disk, so this
// migration only records itself. Build the index by hand with CREATE INDEX
// CONCURRENTLY if and when it is wanted (roles/local/appview README).
export async function up(_db: Kysely<unknown>): Promise<void> {}

// Unchanged from upstream apart from IF EXISTS: the index may never have been
// built.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS like_subject_sort_at_creator_idx`.execute(db)
}
