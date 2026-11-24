import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestNetwork } from '@atproto/dev-env'

// The dataplane migrates at boot. On juice the like-subject index would take
// hours to build and block like writes meanwhile, so the
// dataplane-like-index-by-hand patch makes that migration record itself
// without building anything (roles/local/appview README). The fork keys the
// migration _20261103T000000000Z so it sorts after its own migrations; the
// file keeps upstream's name.
//
// Migrating down drops tables. Other test processes that share the database
// list the tables of every schema whenever they migrate, and one that does so
// while a table is being dropped fails with "relation ... does not exist"
// (and Jest then never exits). So this test gets a database of its own.

const DATABASE = 'eurosky_like_index_test'

async function inServerDatabase(statement: string) {
  const client = new pg.Client({
    connectionString: process.env.DB_POSTGRES_URL,
  })
  await client.connect()
  try {
    await client.query(statement)
  } finally {
    await client.end()
  }
}

function ownDatabaseUrl() {
  const url = new URL(process.env.DB_POSTGRES_URL ?? '')
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe('eurosky: the like-subject index is left to the operator', () => {
  let network: TestNetwork

  beforeAll(async () => {
    await inServerDatabase(`drop database if exists ${DATABASE} with (force)`)
    await inServerDatabase(`create database ${DATABASE}`)
    network = await TestNetwork.create({
      dbPostgresUrl: ownDatabaseUrl(),
      dbPostgresSchema: 'bsky_eurosky_like_index',
    })
  })

  afterAll(async () => {
    await network?.close()
    await inServerDatabase(`drop database if exists ${DATABASE} with (force)`)
  })

  it('records the migration as applied', async () => {
    const { rows } = await sql<{ name: string }>`
      select name from kysely_migration where name = '_20261103T000000000Z'
    `.execute(network.bsky.db.db)
    expect(rows).toHaveLength(1)
  })

  it('does not build the index', async () => {
    const { rows } = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and indexname = 'like_subject_sort_at_creator_idx'
    `.execute(network.bsky.db.db)
    expect(rows).toEqual([])
  })

  it('migrates down past it without the index', async () => {
    const migrator = network.bsky.db.migrator
    const { error } = await migrator.migrateTo('_20261102T120000000Z')
    expect(error).toBeUndefined()
    const { error: upError } = await migrator.migrateToLatest()
    expect(upError).toBeUndefined()
  })
})
