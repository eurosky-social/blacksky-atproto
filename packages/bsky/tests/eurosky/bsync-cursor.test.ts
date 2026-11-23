import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AtpAgent, ids } from '@atproto/api'
import { type SeedClient, TestNetwork, basicSeed } from '@atproto/dev-env'
import type { DidString } from '@atproto/syntax'
import {
  type BsyncCursorStore,
  BsyncSubscription,
  createDbCursorStore,
} from '../../src/index.js'

// Eurosky runs BsyncSubscription as its own service. Upstream keeps the
// subscription's position in memory only, so every restart replays all of
// bsync's operations from the start. With a cursor store it resumes where it
// stopped. To tell a replay from a resume, these tests remove rows from the
// AppView database behind the subscription's back: a replay writes them
// again, a resume leaves them gone.

describe('eurosky: bsync subscription keeps its position across restarts', () => {
  let network: TestNetwork
  let agent: AtpAgent
  let sc: SeedClient

  let alice: DidString
  let bob: DidString
  let carol: DidString

  const headers = async (actor: string, lxm: string) => ({
    headers: await network.serviceHeaders(actor, lxm),
  })

  const restartSubscription = async (cursorStore?: BsyncCursorStore) => {
    await network.bsky.bsyncSub.destroy()
    const sub = new BsyncSubscription({
      config: network.bsky.ctx.cfg,
      db: network.bsky.db,
      cursorStore,
    })
    sub.start()
    network.bsky.bsyncSub = sub
  }

  const storedCursors = async () => {
    const { rows } = await sql<{ stream: string; cursor: string }>`
      select stream, "cursor" from eurosky_bsync_cursor order by stream
    `.execute(network.bsky.db.db)
    return Object.fromEntries(rows.map((row) => [row.stream, row.cursor]))
  }

  const streamHeads = async () => {
    const { op, mute } = await network.bsync.getStreamHeads()
    return { mute, op }
  }

  const aliceBookmarks = async () =>
    (
      await network.bsky.db.db
        .selectFrom('bookmark')
        .select('subjectUri')
        .where('creator', '=', alice)
        .orderBy('subjectUri')
        .execute()
    ).map((row) => row.subjectUri)

  const aliceMutes = async () =>
    (
      await network.bsky.db.db
        .selectFrom('mute')
        .select('subjectDid')
        .where('mutedByDid', '=', alice)
        .orderBy('subjectDid')
        .execute()
    ).map((row) => row.subjectDid)

  const removeAliceRows = async () => {
    await network.bsky.db.db
      .deleteFrom('bookmark')
      .where('creator', '=', alice)
      .execute()
    await network.bsky.db.db
      .deleteFrom('mute')
      .where('mutedByDid', '=', alice)
      .execute()
  }

  const bookmark = async (actor: string, post: { uri: string; cid: string }) =>
    agent.app.bsky.bookmark.createBookmark(
      post,
      await headers(actor, ids.AppBskyBookmarkCreateBookmark),
    )

  const mute = async (actor: string, subject: string) =>
    agent.app.bsky.graph.muteActor(
      { actor: subject },
      await headers(actor, ids.AppBskyGraphMuteActor),
    )

  const postRef = (author: string, i: number) => ({
    uri: sc.posts[author][i].ref.uriStr,
    cid: sc.posts[author][i].ref.cidStr,
  })

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_bsync_cursor',
    })
    agent = network.bsky.getAgent()
    sc = network.getSeedClient()
    await basicSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
    carol = sc.dids.carol
    await network.processAll()

    await restartSubscription(createDbCursorStore(network.bsky.db))
    await bookmark(alice, postRef(bob, 0))
    await mute(alice, carol)
    await network.processAll()
  })

  afterAll(async () => network?.close())

  it('stores its position in both streams', async () => {
    const heads = await streamHeads()
    expect(heads.op).toBeDefined()
    expect(heads.mute).toBeDefined()
    expect(await storedCursors()).toEqual(heads)
  })

  it('resumes from the stored position after a restart', async () => {
    await removeAliceRows()
    await restartSubscription(createDbCursorStore(network.bsky.db))
    await network.processAll()

    expect(await aliceBookmarks()).toEqual([])
    expect(await aliceMutes()).toEqual([])
  })

  it('applies operations made after the restart', async () => {
    await bookmark(alice, postRef(carol, 0))
    await mute(alice, bob)
    await network.processAll()

    expect(await aliceBookmarks()).toEqual([postRef(carol, 0).uri])
    expect(await aliceMutes()).toEqual([bob])
    expect(await storedCursors()).toEqual(await streamHeads())
  })

  it('waits for the store instead of replaying when it cannot be read', async () => {
    const store = createDbCursorStore(network.bsky.db)
    let failures = 0
    const flakyStore: BsyncCursorStore = {
      async get(stream) {
        if (failures < 2) {
          failures++
          throw new Error('database not ready')
        }
        return store.get(stream)
      },
      set: (stream, cursor) => store.set(stream, cursor),
    }

    await removeAliceRows()
    await restartSubscription(flakyStore)
    await network.processAll(10_000)

    expect(failures).toBe(2)
    expect(await aliceBookmarks()).toEqual([])
    expect(await aliceMutes()).toEqual([])
  })

  it('replays every operation when started without a store', async () => {
    await restartSubscription()
    await network.processAll()

    expect(await aliceBookmarks()).toEqual(
      [postRef(bob, 0).uri, postRef(carol, 0).uri].sort(),
    )
    expect(await aliceMutes()).toEqual([bob, carol].sort())
  })
})
