import { Kysely, sql } from 'kysely'

// actor_handle_tgrm_idx (20230309T045948368Z-init) indexes "handle" with
// gist_trgm_ops to back the SQL search fallback's LIKE '%term%'. But
// gist_trgm_ops also indexes `=`, so the planner may pick the trigram index for
// plain handle equality — and on a large actor table it does, pricing the GiST
// path at 2.64 against the unique btree actor_handle_key's 2.78 and losing the
// tie. getDidsByHandles fronts every handle-addressed XRPC call, so that costs
// ~1.2s and ~187k buffers per lookup where the btree needs ~0.1ms and 5.
//
// Indexing lower("handle") keeps the fallback index-backed while making it
// ineligible for `handle = $1`, returning equality to the btree. Idempotent, so
// deployments that already applied this by hand converge cleanly.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('actor_handle_lower_tgrm_idx')
    .ifNotExists()
    .on('actor')
    .using('gist')
    .expression(sql`lower("handle") gist_trgm_ops`)
    .execute()

  await db.schema.dropIndex('actor_handle_tgrm_idx').ifExists().execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('actor_handle_tgrm_idx')
    .ifNotExists()
    .on('actor')
    .using('gist')
    .expression(sql`"handle" gist_trgm_ops`)
    .execute()

  await db.schema.dropIndex('actor_handle_lower_tgrm_idx').ifExists().execute()
}
