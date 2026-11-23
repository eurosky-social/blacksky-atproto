import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AtpAgent, ids } from '@atproto/api'
import { type SeedClient, TestNetwork, basicSeed } from '@atproto/dev-env'
import type { DidString } from '@atproto/syntax'
import { BsyncSubscription } from '../../src/index.js'

// Eurosky runs its AppView with MockBsync, which wrote private data (bookmarks,
// mutes, drafts, activity subscriptions, notification preferences) straight
// into the AppView database. Upstream replaced it with a real bsync service
// that the dataplane follows through BsyncSubscription. On switch day the
// AppView database already holds those rows, but bsync starts empty and has
// never seen them. These tests reproduce that state and check that users can
// still change and remove what they saved before the switch, and that a
// restart of the subscription (which keeps its cursor in memory only, so it
// replays every operation from the start) leaves the data as it was.

describe('eurosky: switching the AppView from MockBsync to bsync', () => {
  let network: TestNetwork
  let agent: AtpAgent
  let sc: SeedClient

  let alice: DidString
  let bob: DidString
  let carol: DidString

  let bobPostUri: string
  let bobPostCid: string
  let threadRootUri: string
  let listUri: string
  let draftId: string

  const headers = async (actor: string, lxm: string) => ({
    headers: await network.serviceHeaders(actor, lxm),
  })

  // Same as switch day: bsync's own tables are empty, the subscription starts
  // without a cursor, and the AppView database keeps every row.
  const wipeBsync = async () => {
    const db = network.bsync.ctx.db.db
    for (const table of [
      'operation',
      'mute_op',
      'mute_item',
      'notif_op',
      'notif_item',
    ] as const) {
      await db.deleteFrom(table).execute()
    }
  }

  const restartSubscription = async () => {
    await network.bsky.bsyncSub.destroy()
    const sub = new BsyncSubscription({
      config: network.bsky.ctx.cfg,
      db: network.bsky.db,
    })
    sub.start()
    network.bsky.bsyncSub = sub
  }

  // Alice's private rows in the AppView database, without the timestamps a
  // replay is allowed to refresh.
  const aliceRows = async () => {
    const db = network.bsky.db.db
    return {
      bookmark: await db
        .selectFrom('bookmark')
        .select(['key', 'subjectUri', 'subjectCid'])
        .where('creator', '=', alice)
        .orderBy('key')
        .execute(),
      mute: await db
        .selectFrom('mute')
        .select(['subjectDid', 'onlyReposts', 'onlyQuoteposts'])
        .where('mutedByDid', '=', alice)
        .orderBy('subjectDid')
        .execute(),
      listMute: await db
        .selectFrom('list_mute')
        .select('listUri')
        .where('mutedByDid', '=', alice)
        .orderBy('listUri')
        .execute(),
      threadMute: await db
        .selectFrom('thread_mute')
        .select('rootUri')
        .where('mutedByDid', '=', alice)
        .orderBy('rootUri')
        .execute(),
      draft: await db
        .selectFrom('draft')
        .select(['key', 'payload'])
        .where('creator', '=', alice)
        .orderBy('key')
        .execute(),
      activitySubscription: await db
        .selectFrom('activity_subscription')
        .select(['key', 'subjectDid', 'post', 'reply'])
        .where('creator', '=', alice)
        .orderBy('key')
        .execute(),
      privateData: await db
        .selectFrom('private_data')
        .select(['namespace', 'key', 'payload'])
        .where('actorDid', '=', alice)
        .orderBy('namespace')
        .orderBy('key')
        .execute(),
    }
  }

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_bsync_switch',
    })
    agent = network.bsky.getAgent()
    sc = network.getSeedClient()
    await basicSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
    carol = sc.dids.carol
    const list = await sc.createList(bob, 'bob mods', 'mod')
    await network.processAll()

    bobPostUri = sc.posts[bob][0].ref.uriStr
    bobPostCid = sc.posts[bob][0].ref.cidStr
    threadRootUri = sc.posts[alice][1].ref.uriStr
    listUri = list.uriStr

    // Everything alice saves before the switch.
    await agent.app.bsky.bookmark.createBookmark(
      { uri: bobPostUri, cid: bobPostCid },
      await headers(alice, ids.AppBskyBookmarkCreateBookmark),
    )
    await agent.app.bsky.graph.muteActor(
      { actor: carol },
      await headers(alice, ids.AppBskyGraphMuteActor),
    )
    await agent.app.bsky.graph.muteActorList(
      { list: listUri },
      await headers(alice, ids.AppBskyGraphMuteActorList),
    )
    await agent.app.bsky.graph.muteThread(
      { root: threadRootUri },
      await headers(alice, ids.AppBskyGraphMuteThread),
    )
    await agent.app.bsky.draft.createDraft(
      { draft: { posts: [{ text: 'saved before the switch' }] } },
      await headers(alice, ids.AppBskyDraftCreateDraft),
    )
    await agent.app.bsky.notification.putActivitySubscription(
      { subject: bob, activitySubscription: { post: true, reply: false } },
      await headers(alice, ids.AppBskyNotificationPutActivitySubscription),
    )
    await agent.app.bsky.notification.putPreferencesV2(
      { like: { include: 'follows', list: true, push: false } },
      await headers(alice, ids.AppBskyNotificationPutPreferencesV2),
    )
    await network.processAll()

    const { data: drafts } = await agent.app.bsky.draft.getDrafts(
      {},
      await headers(alice, ids.AppBskyDraftGetDrafts),
    )
    draftId = drafts.drafts[0].id

    await wipeBsync()
    await restartSubscription()
    await network.processAll()
  })

  afterAll(async () => network?.close())

  it('still shows everything saved before the switch', async () => {
    // bsync has never seen any of it
    expect(await network.bsync.getStreamHeads()).toEqual({
      op: undefined,
      mute: undefined,
      notif: undefined,
    })

    const rows = await aliceRows()
    expect(rows.bookmark).toHaveLength(1)
    expect(rows.mute.map((m) => m.subjectDid)).toEqual([carol])
    expect(rows.listMute.map((m) => m.listUri)).toEqual([listUri])
    expect(rows.threadMute.map((m) => m.rootUri)).toEqual([threadRootUri])
    expect(rows.draft).toHaveLength(1)
    expect(rows.activitySubscription).toHaveLength(1)

    const { data: prefs } = await agent.app.bsky.notification.getPreferences(
      {},
      await headers(alice, ids.AppBskyNotificationGetPreferences),
    )
    expect(prefs.preferences.like).toMatchObject({
      include: 'follows',
      list: true,
      push: false,
    })
  })

  it('does not duplicate a bookmark saved before the switch', async () => {
    await agent.app.bsky.bookmark.createBookmark(
      { uri: bobPostUri, cid: bobPostCid },
      await headers(alice, ids.AppBskyBookmarkCreateBookmark),
    )
    await network.processAll()
    expect((await aliceRows()).bookmark).toHaveLength(1)
  })

  it('removes a bookmark saved before the switch', async () => {
    await agent.app.bsky.bookmark.deleteBookmark(
      { uri: bobPostUri },
      await headers(alice, ids.AppBskyBookmarkDeleteBookmark),
    )
    await network.processAll()
    expect((await aliceRows()).bookmark).toHaveLength(0)

    const { data } = await agent.app.bsky.bookmark.getBookmarks(
      {},
      await headers(alice, ids.AppBskyBookmarkGetBookmarks),
    )
    expect(data.bookmarks).toHaveLength(0)
  })

  it('unmutes an account, a list and a thread muted before the switch', async () => {
    await agent.app.bsky.graph.unmuteActor(
      { actor: carol },
      await headers(alice, ids.AppBskyGraphUnmuteActor),
    )
    await agent.app.bsky.graph.unmuteActorList(
      { list: listUri },
      await headers(alice, ids.AppBskyGraphUnmuteActorList),
    )
    await agent.app.bsky.graph.unmuteThread(
      { root: threadRootUri },
      await headers(alice, ids.AppBskyGraphUnmuteThread),
    )
    await network.processAll()

    const rows = await aliceRows()
    expect(rows.mute).toHaveLength(0)
    expect(rows.listMute).toHaveLength(0)
    expect(rows.threadMute).toHaveLength(0)
  })

  it('updates, then deletes a draft saved before the switch', async () => {
    await agent.app.bsky.draft.updateDraft(
      {
        draft: {
          id: draftId,
          draft: { posts: [{ text: 'edited after the switch' }] },
        },
      },
      await headers(alice, ids.AppBskyDraftUpdateDraft),
    )
    await network.processAll()
    const { data } = await agent.app.bsky.draft.getDrafts(
      {},
      await headers(alice, ids.AppBskyDraftGetDrafts),
    )
    expect(data.drafts).toHaveLength(1)
    expect(data.drafts[0].draft.posts[0].text).toBe('edited after the switch')

    await agent.app.bsky.draft.deleteDraft(
      { id: draftId },
      await headers(alice, ids.AppBskyDraftDeleteDraft),
    )
    await network.processAll()
    expect((await aliceRows()).draft).toHaveLength(0)
  })

  it('changes, then removes an activity subscription made before the switch', async () => {
    await agent.app.bsky.notification.putActivitySubscription(
      { subject: bob, activitySubscription: { post: true, reply: true } },
      await headers(alice, ids.AppBskyNotificationPutActivitySubscription),
    )
    await network.processAll()
    const changed = (await aliceRows()).activitySubscription
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      subjectDid: bob,
      post: true,
      reply: true,
    })

    await agent.app.bsky.notification.putActivitySubscription(
      { subject: bob, activitySubscription: { post: false, reply: false } },
      await headers(alice, ids.AppBskyNotificationPutActivitySubscription),
    )
    await network.processAll()
    expect((await aliceRows()).activitySubscription).toHaveLength(0)
  })

  it('updates notification preferences saved before the switch', async () => {
    await agent.app.bsky.notification.putPreferencesV2(
      { like: { include: 'all', list: false, push: true } },
      await headers(alice, ids.AppBskyNotificationPutPreferencesV2),
    )
    await network.processAll()
    const { data } = await agent.app.bsky.notification.getPreferences(
      {},
      await headers(alice, ids.AppBskyNotificationGetPreferences),
    )
    expect(data.preferences.like).toMatchObject({
      include: 'all',
      list: false,
      push: true,
    })
  })

  it('ends in the same state after a restart replays every operation', async () => {
    // Leave a mix of live and removed items behind, so the replay has to
    // re-create and re-delete rows on the way.
    await agent.app.bsky.bookmark.createBookmark(
      { uri: bobPostUri, cid: bobPostCid },
      await headers(alice, ids.AppBskyBookmarkCreateBookmark),
    )
    await agent.app.bsky.graph.muteActor(
      { actor: carol },
      await headers(alice, ids.AppBskyGraphMuteActor),
    )
    await agent.app.bsky.draft.createDraft(
      { draft: { posts: [{ text: 'kept' }] } },
      await headers(alice, ids.AppBskyDraftCreateDraft),
    )
    await agent.app.bsky.notification.putActivitySubscription(
      { subject: carol, activitySubscription: { post: true, reply: false } },
      await headers(alice, ids.AppBskyNotificationPutActivitySubscription),
    )
    await network.processAll()
    const before = await aliceRows()

    // the log the restarted subscription replays from the start
    const heads = await network.bsync.getStreamHeads()
    expect(Number(heads.op)).toBeGreaterThan(5)
    expect(Number(heads.mute)).toBeGreaterThan(3)

    await restartSubscription()
    await network.processAll()

    expect(await aliceRows()).toEqual(before)
  })
})
