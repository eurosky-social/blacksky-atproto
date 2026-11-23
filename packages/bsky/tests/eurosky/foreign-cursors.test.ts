import { Code, ConnectError } from '@connectrpc/connect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppBskyFeedDefs, type AtpAgent, ids } from '@atproto/api'
import { type SeedClient, TestNetwork, basicSeed } from '@atproto/dev-env'

// EUR-648: a client that switches AppViews mid-scroll sends the next-page
// cursor it got from the other one. Bluesky's are a bare ISO time for feeds
// and likes, a record key for follower lists and base64 JSON for search. The
// dataplane threw "Malformed cursor" as an xrpc error, which reached the
// AppView as a Connect internal error: every such request was a 500.
//
// Now an ISO time continues the page (items older than that time), and any
// other cursor the dataplane cannot read is a 400.

describe('eurosky: cursors from another AppView', () => {
  let network: TestNetwork
  let agent: AtpAgent
  let sc: SeedClient

  let alice: string

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_foreign_cursors',
    })
    agent = network.bsky.getAgent()
    sc = network.getSeedClient()
    await basicSeed(sc)
    await network.processAll()
    alice = sc.dids.alice
  })

  afterAll(async () => network?.close())

  // A feed item is one post or repost by one account.
  const itemKey = (item: AppBskyFeedDefs.FeedViewPost) => {
    const by = AppBskyFeedDefs.isReasonRepost(item.reason)
      ? item.reason.by.did
      : item.post.author.did
    return `${item.post.uri}|${by}`
  }

  const feedItemSortAts = async (originators: string[]) => {
    const rows = await network.bsky.db.db
      .selectFrom('feed_item')
      .where('originatorDid', 'in', originators)
      .select(['postUri', 'originatorDid', 'sortAt'])
      .execute()
    return new Map(
      rows.map((row) => [`${row.postUri}|${row.originatorDid}`, row.sortAt]),
    )
  }

  // A time between the newest items and the rest, as Bluesky would send it.
  const middleTime = (sortAts: string[]) => {
    const sorted = [...new Set(sortAts)].sort().reverse()
    expect(sorted.length).toBeGreaterThanOrEqual(3)
    return new Date(sorted[1]).toISOString()
  }

  it('continues an author feed from an ISO time cursor', async () => {
    const full = await agent.app.bsky.feed.getAuthorFeed({
      actor: alice,
      limit: 100,
    })
    const sortAts = await feedItemSortAts([alice])
    const cursor = middleTime(
      full.data.feed.map((i) => sortAts.get(itemKey(i))!),
    )

    const res = await agent.app.bsky.feed.getAuthorFeed({
      actor: alice,
      limit: 100,
      cursor,
    })

    const expected = full.data.feed
      .filter((item) => sortAts.get(itemKey(item))! < cursor)
      .map(itemKey)
    expect(expected.length).toBeGreaterThan(0)
    expect(res.data.feed.map(itemKey)).toEqual(expected)
  })

  it('continues a timeline from an ISO time cursor', async () => {
    const headers = await network.serviceHeaders(
      alice,
      ids.AppBskyFeedGetTimeline,
    )
    const full = await agent.app.bsky.feed.getTimeline(
      { limit: 100 },
      { headers },
    )
    const sortAts = await feedItemSortAts(Object.values(sc.dids))
    const cursor = middleTime(
      full.data.feed.map((i) => sortAts.get(itemKey(i))!),
    )

    const res = await agent.app.bsky.feed.getTimeline(
      { limit: 100, cursor },
      { headers },
    )

    const expected = full.data.feed
      .filter((item) => sortAts.get(itemKey(item))! < cursor)
      .map(itemKey)
    expect(expected.length).toBeGreaterThan(0)
    expect(res.data.feed.map(itemKey)).toEqual(expected)
  })

  it('continues likes from an ISO time cursor', async () => {
    const uri = sc.posts[alice][1].ref.uriStr
    const rows = await network.bsky.db.db
      .selectFrom('like')
      .where('subject', '=', uri)
      .select(['creator', 'sortAt'])
      .execute()
    const sortAts = new Map(rows.map((row) => [row.creator, row.sortAt]))
    const cursor = middleTime(rows.map((row) => row.sortAt))

    const full = await agent.app.bsky.feed.getLikes({ uri, limit: 100 })
    const res = await agent.app.bsky.feed.getLikes({ uri, limit: 100, cursor })

    const expected = full.data.likes
      .filter((like) => sortAts.get(like.actor.did)! < cursor)
      .map((like) => like.actor.did)
    expect(expected.length).toBeGreaterThan(0)
    expect(res.data.likes.map((like) => like.actor.did)).toEqual(expected)
  })

  it('still pages with its own cursors', async () => {
    const first = await agent.app.bsky.feed.getAuthorFeed({
      actor: alice,
      limit: 2,
    })
    expect(first.data.cursor).toMatch(/^\d+__/)
    const next = await agent.app.bsky.feed.getAuthorFeed({
      actor: alice,
      limit: 2,
      cursor: first.data.cursor,
    })
    const full = await agent.app.bsky.feed.getAuthorFeed({
      actor: alice,
      limit: 4,
    })
    expect([...first.data.feed, ...next.data.feed].map(itemKey)).toEqual(
      full.data.feed.map(itemKey),
    )
  })

  it.each([
    ['a record key', '3lbtnsp4okm2k'],
    ['base64 JSON', 'eyJzIjpbMTc2Mjg4NjY0MCwiYWJjIl19'],
    ['an impossible ISO time', '2026-13-45T25:61:61.000Z'],
    ['three parts', '1__2__3'],
  ])('answers a cursor that is %s with a 400', async (_, cursor) => {
    await expect(
      agent.app.bsky.graph.getFollowers({ actor: alice, cursor }),
    ).rejects.toMatchObject({
      status: 400,
      error: 'InvalidRequest',
      message: 'Malformed cursor',
    })
    await expect(
      agent.app.bsky.feed.getAuthorFeed({ actor: alice, cursor }),
    ).rejects.toMatchObject({ status: 400, error: 'InvalidRequest' })
  })

  it('has the dataplane reject a search cursor as InvalidArgument', async () => {
    // Search falls back to SQL without palomar; searchPostsV2's handler
    // already turns InvalidArgument into a 400.
    const err = await network.bsky.ctx.dataplane
      .searchPostsV2({
        params: { query: 'hello', limit: 10, cursor: '{"s":[1762886640,"x"]}' },
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectError)
    expect((err as ConnectError).code).toBe(Code.InvalidArgument)
  })
})
