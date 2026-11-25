import type { Kysely } from 'kysely'

// Eurosky: one row per reply that names a second of the video it answers
// (network.eurosky.mediaTime). The indexer (rsky-wintermute in production)
// writes it next to the post row, so moments are read without opening the
// records of a video's other replies.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('post_media_time')
    .ifNotExists()
    .addColumn('postUri', 'varchar', (col) => col.primaryKey())
    .addColumn('parentUri', 'varchar', (col) => col.notNull())
    .addColumn('seconds', 'integer', (col) => col.notNull())
    .execute()
  await db.schema
    .createIndex('post_media_time_parent_idx')
    .ifNotExists()
    .on('post_media_time')
    .columns(['parentUri', 'seconds'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('post_media_time').ifExists().execute()
}
