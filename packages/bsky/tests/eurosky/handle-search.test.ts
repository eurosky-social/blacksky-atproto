import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AtpAgent, ids } from '@atproto/api'
import { type SeedClient, TestNetwork, basicSeed } from '@atproto/dev-env'

// Without a search service the dataplane looks handles up in SQL. Handles are
// stored in lowercase, so a query typed with capitals found nobody until the
// dataplane-search-case-insensitive patch lowercased both sides.

describe('eurosky: handle search without a search service', () => {
  let network: TestNetwork
  let agent: AtpAgent
  let sc: SeedClient

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_handle_search',
    })
    agent = network.bsky.getAgent()
    sc = network.getSeedClient()
    await basicSeed(sc)
    await network.processAll()
  })

  afterAll(async () => network?.close())

  const search = async (q: string) => {
    const { data } = await agent.app.bsky.actor.searchActors(
      { q },
      {
        headers: await network.serviceHeaders(
          sc.dids.bob,
          ids.AppBskyActorSearchActors,
        ),
      },
    )
    return data.actors.map((actor) => actor.handle)
  }

  it('finds a handle from a lowercase query', async () => {
    expect(await search('alice')).toContain(sc.accounts[sc.dids.alice].handle)
  })

  it('finds a handle from a query with capitals', async () => {
    const handle = sc.accounts[sc.dids.alice].handle
    expect(await search('Alice')).toContain(handle)
    expect(await search('ALICE.TEST')).toContain(handle)
  })
})
