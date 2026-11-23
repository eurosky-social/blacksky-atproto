import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestNetwork } from '@atproto/dev-env'

// EUR-647: wintermute stores labeler records under any record key, and a few
// accounts on juice have several. The dataplane's "is this account a labeler"
// subquery then returned more than one row and failed the whole getActors
// call, so every page showing such an account failed. The
// dataplane-labeler-self-only patch counts only the `self` record, which is
// the only one upstream's indexer stores.

describe('eurosky: labeler records under keys other than self', () => {
  let network: TestNetwork

  const several = 'did:plc:several-labeler-records'
  const noSelf = 'did:plc:no-self-labeler-record'
  const single = 'did:plc:one-labeler-record'
  const plain = 'did:plc:not-a-labeler'

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_labeler_records',
    })
    const { db } = network.bsky.db
    const indexedAt = new Date().toISOString()
    await db
      .insertInto('actor')
      .values(
        [several, noSelf, single, plain].map((did) => ({
          did,
          handle: `${did.split(':')[2]}.test`,
          indexedAt,
        })),
      )
      .execute()
    await db
      .insertInto('labeler')
      .values([
        labeler(several, 'self', indexedAt),
        labeler(several, '3lbbbbbbbbbb2', indexedAt),
        labeler(several, '3lcccccccccc2', indexedAt),
        labeler(noSelf, '3ldddddddddd2', indexedAt),
        labeler(noSelf, '3leeeeeeeeee2', indexedAt),
        labeler(single, 'self', indexedAt),
      ])
      .execute()
  })

  afterAll(async () => network?.close())

  it('answers for an account with several labeler records', async () => {
    const { actors } = await network.bsky.ctx.dataplane.getActors({
      dids: [several, single, plain],
    })
    expect(actors.map((actor) => actor.labeler)).toEqual([true, true, false])
  })

  it('does not count an account without a self record', async () => {
    const { actors } = await network.bsky.ctx.dataplane.getActors({
      dids: [noSelf],
    })
    expect(actors.map((actor) => actor.labeler)).toEqual([false])
  })
})

function labeler(creator: string, rkey: string, indexedAt: string) {
  return {
    uri: `at://${creator}/app.bsky.labeler.service/${rkey}`,
    cid: `labeler-cid-${creator}-${rkey}`,
    creator,
    createdAt: indexedAt,
    indexedAt,
  }
}
