import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppBskyFeedPost } from '@atproto/api'
import {
  type RecordRef,
  type SeedClient,
  TestNetwork,
  usersSeed,
} from '@atproto/dev-env'
import type { AtUriString, DidString } from '@atproto/syntax'
import {
  MAX_REPLIES_PER_MOMENT,
  groupIntoMoments,
} from '../../src/api/network/eurosky/feed/moments.js'

// network.eurosky.feed.getMoments. mu writes the second of a video a reply
// is about into an extra field of the reply's post record; the AppView reads
// it back from the stored record and groups a video's direct replies into
// moments. The answer must not count replies the AppView would not show.

const FIELD = 'network.eurosky.mediaTime'

const mediaTime = (seconds: unknown) =>
  ({
    [FIELD]: { $type: FIELD, seconds },
  }) as Partial<AppBskyFeedPost.Record>

describe('eurosky: moments of a video post', () => {
  let network: TestNetwork
  let sc: SeedClient
  let alice: DidString
  let bob: DidString
  let carol: DidString
  let dan: DidString
  let video: RecordRef
  let otherPost: RecordRef
  let quietPost: RecordRef
  const uris: Record<string, string> = {}

  const reply = async (
    name: string,
    by: DidString,
    overrides?: Partial<AppBskyFeedPost.Record>,
    parent: RecordRef = video,
    text = name,
  ) => {
    const res = await sc.reply(by, video, parent, text, undefined, undefined, {
      ...overrides,
    })
    uris[name] = res.ref.uriStr
    return res.ref
  }

  const getMoments = async (uri: string) => {
    const res = await fetch(
      `${network.bsky.url}/xrpc/network.eurosky.feed.getMoments?uri=${encodeURIComponent(uri)}`,
    )
    expect(res.status).toBe(200)
    return res.json()
  }

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_media_time_moments',
    })
    sc = network.getSeedClient()
    await usersSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
    carol = sc.dids.carol
    dan = sc.dids.dan

    video = (await sc.post(alice, 'a video')).ref
    otherPost = (await sc.post(alice, 'another post')).ref
    quietPost = (await sc.post(alice, 'a post nobody linked to')).ref

    // first moment: 0:41 and 0:50
    const at41 = await reply('at41', bob, mediaTime(41))
    await reply('at50', carol, mediaTime(50))
    // second moment: 3:20, more than 30 s after 0:50
    await reply('at200', dan, mediaTime(200))
    // not counted
    await reply('plain', bob)
    await reply('negative', carol, mediaTime(-3))
    await reply('string', carol, mediaTime('41'))
    await reply('word', carol, mediaTime('forty'))
    await reply('tooLong', carol, mediaTime(360_001))
    await reply('notObject', carol, {
      [FIELD]: 41,
    } as unknown as Partial<AppBskyFeedPost.Record>)
    await reply('otherType', carol, {
      [FIELD]: { $type: 'x.y.z', seconds: 7 },
    } as Partial<AppBskyFeedPost.Record>)
    await reply('fieldInText', carol, undefined, video, `"${FIELD}": 9`)
    // a reply to a reply, and a linked reply to another post
    await reply('nested', dan, mediaTime(42), at41)
    await sc.reply(
      alice,
      otherPost,
      otherPost,
      'elsewhere',
      undefined,
      undefined,
      mediaTime(41),
    )
    await network.processAll()
  })

  afterAll(async () => network?.close())

  it('groups the linked direct replies by second', async () => {
    const res = await getMoments(video.uriStr)
    expect(res).toEqual({
      uri: video.uriStr,
      replyCount: 3,
      moments: [
        {
          startSeconds: 41,
          endSeconds: 50,
          replyCount: 2,
          replies: [
            { uri: uris.at41, seconds: 41 },
            { uri: uris.at50, seconds: 50 },
          ],
        },
        {
          startSeconds: 200,
          endSeconds: 200,
          replyCount: 1,
          replies: [{ uri: uris.at200, seconds: 200 }],
        },
      ],
    })
  })

  it('answers with no moments for a post without linked replies', async () => {
    expect(await getMoments(quietPost.uriStr)).toEqual({
      uri: quietPost.uriStr,
      replyCount: 0,
      moments: [],
    })
  })

  it('counts linked replies to each post separately', async () => {
    const res = await getMoments(otherPost.uriStr)
    expect(res.replyCount).toBe(1)
    expect(res.moments).toEqual([
      expect.objectContaining({ startSeconds: 41, replyCount: 1 }),
    ])
  })

  it('reports when there are more linked replies than it reads', async () => {
    const res = await network.bsky.ctx.dataplane.getMediaTimeReplies({
      postUri: video.uriStr,
      limit: 2,
    })
    expect(res.replies).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })

  it('leaves out replies the AppView would not show', async () => {
    const extra = {
      takenDown: await reply('takenDown', bob, mediaTime(300)),
      byTakenDown: await reply('byTakenDown', carol, mediaTime(301)),
      byDeactivated: await reply('byDeactivated', dan, mediaTime(302)),
      againstGate: await reply('againstGate', bob, mediaTime(303)),
      deleted: await reply('deleted', bob, mediaTime(304)),
      kept: await reply('kept', bob, mediaTime(305)),
    }
    await network.processAll()
    await sc.deletePost(bob, extra.deleted.uri)
    await network.processAll()

    const { dataplane } = network.bsky.ctx
    await dataplane.takedownRecord({
      recordUri: extra.takenDown.uriStr,
      ref: 'test',
    })
    await dataplane.takedownActor({ did: carol, ref: 'test' })
    await dataplane.updateActorUpstreamStatus({
      actorDid: dan,
      active: false,
      upstreamStatus: 'deactivated',
    })
    await network.bsky.db.db
      .updateTable('post')
      .set({ violatesThreadGate: true })
      .where('uri', '=', extra.againstGate.uriStr)
      .execute()

    const res = await getMoments(video.uriStr)
    // bob's 0:41 stays; carol's 0:50 and dan's 3:20 go with their accounts
    expect(res.moments).toEqual([
      {
        startSeconds: 41,
        endSeconds: 41,
        replyCount: 1,
        replies: [{ uri: uris.at41, seconds: 41 }],
      },
      {
        startSeconds: 305,
        endSeconds: 305,
        replyCount: 1,
        replies: [{ uri: uris.kept, seconds: 305 }],
      },
    ])
    expect(res.replyCount).toBe(2)
  })
})

describe('eurosky: grouping into moments', () => {
  const r = (seconds: number, n = seconds) => ({
    uri: `at://did:plc:a/app.bsky.feed.post/${String(n).padStart(4, '0')}` as AtUriString,
    seconds,
  })

  it('starts a moment after a gap of more than 30 seconds', () => {
    const moments = groupIntoMoments([r(100), r(0), r(30), r(61), r(130)])
    expect(
      moments.map((m) => [m.startSeconds, m.endSeconds, m.replyCount]),
    ).toEqual([
      [0, 30, 2],
      [61, 61, 1],
      [100, 130, 2],
    ])
  })

  it('measures the gap from the previous reply, not the first', () => {
    const moments = groupIntoMoments([r(0), r(25), r(50), r(75)])
    expect(moments).toHaveLength(1)
    expect(moments[0].endSeconds).toBe(75)
  })

  it('lists at most 100 replies per moment but counts all', () => {
    const replies = Array.from({ length: 150 }, (_, i) => r(10, i))
    const [moment] = groupIntoMoments(replies)
    expect(moment.replyCount).toBe(150)
    expect(moment.replies).toHaveLength(MAX_REPLIES_PER_MOMENT)
  })

  it('returns nothing for no replies', () => {
    expect(groupIntoMoments([])).toEqual([])
  })
})
