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
  groupCountsIntoMoments,
  groupIntoMoments,
} from '../../src/api/network/eurosky/feed/moments.js'
import { TtlCache } from '../../src/api/network/eurosky/feed/summary-cache.js'
import {
  MAX_MEDIA_TIME_SECONDS,
  mediaTimeSeconds,
} from '../../src/data-plane/server/indexing/media-time.js'

// network.eurosky.feed.getMoments. mu writes the second of a video a reply
// is about into an extra field of the reply's post record; the indexer keeps
// valid values in post_media_time, and the AppView groups a video's direct
// replies into moments. The answer must not count replies the AppView would
// not show.

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
  let answeredVideo: RecordRef
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

  const getSummaries = async (uris: string[]) => {
    const query = uris.map((uri) => `uris=${encodeURIComponent(uri)}`)
    const res = await fetch(
      `${network.bsky.url}/xrpc/network.eurosky.feed.getMomentSummaries?${query.join('&')}`,
    )
    expect(res.status).toBe(200)
    return res.json()
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

    // a video whose author, alice, answers some of its comments
    answeredVideo = (await sc.post(alice, 'a video alice answers on')).ref
    const onAnswered = async (
      name: string,
      by: DidString,
      parent: RecordRef,
      overrides?: Partial<AppBskyFeedPost.Record>,
    ) => {
      const res = await sc.reply(
        by,
        answeredVideo,
        parent,
        name,
        undefined,
        undefined,
        { ...overrides },
      )
      uris[name] = res.ref.uriStr
      return res.ref
    }
    const q10 = await onAnswered('q10', bob, answeredVideo, mediaTime(10))
    const q12 = await onAnswered('q12', carol, answeredVideo, mediaTime(12))
    await onAnswered('q14', dan, answeredVideo, mediaTime(14))
    await onAnswered('own15', alice, answeredVideo, mediaTime(15))
    await onAnswered('answer10', alice, q10)
    const bobOn12 = await onAnswered('bobOn12', bob, q12)
    await onAnswered('aliceUnderBob', alice, bobOn12)
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
          startSeconds: 36,
          endSeconds: 50,
          replyCount: 2,
          unansweredCount: 2,
          replies: [
            { uri: uris.at41, seconds: 41 },
            { uri: uris.at50, seconds: 50 },
          ],
        },
        {
          startSeconds: 195,
          endSeconds: 200,
          replyCount: 1,
          unansweredCount: 1,
          replies: [{ uri: uris.at200, seconds: 200 }],
        },
      ],
    })
  })

  it('keeps only valid linked replies in post_media_time', async () => {
    const rows = await network.bsky.db.db
      .selectFrom('post_media_time')
      .selectAll()
      .where('parentUri', 'in', [video.uriStr, uris.at41])
      .orderBy('seconds')
      .execute()
    expect(rows).toEqual([
      { postUri: uris.at41, parentUri: video.uriStr, seconds: 41 },
      // a reply to a reply is kept under its own parent
      { postUri: uris.nested, parentUri: uris.at41, seconds: 42 },
      { postUri: uris.at50, parentUri: video.uriStr, seconds: 50 },
      { postUri: uris.at200, parentUri: video.uriStr, seconds: 200 },
    ])
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
      expect.objectContaining({ startSeconds: 36, replyCount: 1 }),
    ])
  })

  it("says which replies the video's author answered", async () => {
    const res = await getMoments(answeredVideo.uriStr)
    expect(res.moments).toEqual([
      {
        startSeconds: 5,
        endSeconds: 15,
        replyCount: 4,
        // carol's 0:12 has only bob's answer, and alice's under that; dan's
        // 0:14 has none; alice's own 0:15 isn't waiting for her
        unansweredCount: 2,
        replies: [
          { uri: uris.q10, seconds: 10, authorReplied: true },
          { uri: uris.q12, seconds: 12 },
          { uri: uris.q14, seconds: 14 },
          { uri: uris.own15, seconds: 15 },
        ],
      },
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

  it('summarises several posts at once, in the order asked', async () => {
    const res = await getSummaries([
      quietPost.uriStr,
      video.uriStr,
      otherPost.uriStr,
      video.uriStr,
    ])
    const videoSummary = {
      uri: video.uriStr,
      replyCount: 3,
      moments: [
        { startSeconds: 36, endSeconds: 50, replyCount: 2 },
        { startSeconds: 195, endSeconds: 200, replyCount: 1 },
      ],
    }
    expect(res.summaries).toEqual([
      { uri: quietPost.uriStr, replyCount: 0, moments: [] },
      videoSummary,
      {
        uri: otherPost.uriStr,
        replyCount: 1,
        moments: [{ startSeconds: 36, endSeconds: 41, replyCount: 1 }],
      },
      videoSummary,
    ])
  })

  it('counts several replies at the same second', async () => {
    const res = await network.bsky.ctx.dataplane.getMediaTimeCounts({
      postUris: [video.uriStr, quietPost.uriStr],
    })
    expect(
      res.counts
        .map((c) => [c.postUri, c.seconds, c.count])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [video.uriStr, 41, 1],
      [video.uriStr, 50, 1],
      [video.uriStr, 200, 1],
    ])
  })

  it('answers from its cache: summaries for a minute, moments for 30 seconds', async () => {
    expect((await getMoments(video.uriStr)).replyCount).toBe(3)
    // carol's account is taken down in the next test, so this reply does
    // not change what that test expects
    await reply('late', carol, mediaTime(600))
    await network.processAll()
    const summaries = await getSummaries([video.uriStr])
    expect(summaries.summaries[0].replyCount).toBe(3)
    const moments = await getMoments(video.uriStr)
    expect(moments.replyCount).toBe(3)
    const fresh = await network.bsky.ctx.dataplane.getMediaTimeReplies({
      postUri: video.uriStr,
    })
    expect(fresh.replies).toHaveLength(4)
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

    // getMoments has the video cached from earlier tests, so this asks the
    // dataplane, which both endpoints read from
    const res = await dataplane.getMediaTimeReplies({ postUri: video.uriStr })
    // bob's 0:41 stays; carol's 0:50 and dan's 3:20 go with their accounts
    expect(res.replies).toEqual([
      { uri: uris.at41, seconds: 41, authorReplied: false },
      { uri: uris.kept, seconds: 305, authorReplied: false },
    ])
    const counts = await dataplane.getMediaTimeCounts({
      postUris: [video.uriStr],
    })
    expect(counts.counts.map((c) => c.seconds).sort((a, b) => a - b)).toEqual([
      41, 305,
    ])
    // the deleted reply's row went with it
    const deletedRow = await network.bsky.db.db
      .selectFrom('post_media_time')
      .select('postUri')
      .where('postUri', '=', extra.deleted.uriStr)
      .executeTakeFirst()
    expect(deletedRow).toBeUndefined()
  })
})

describe('eurosky: reading the second a record names', () => {
  const field = 'network.eurosky.mediaTime'

  it('reads whole seconds within 100 hours', () => {
    expect(mediaTimeSeconds({ [field]: { $type: field, seconds: 41 } })).toBe(
      41,
    )
    expect(mediaTimeSeconds({ [field]: { seconds: 0 } })).toBe(0)
    expect(
      mediaTimeSeconds({ [field]: { seconds: MAX_MEDIA_TIME_SECONDS } }),
    ).toBe(MAX_MEDIA_TIME_SECONDS)
  })

  it('ignores anything else', () => {
    for (const value of [
      undefined,
      null,
      41,
      [41],
      { $type: 'x.y.z', seconds: 7 },
      { $type: null, seconds: 7 },
      { seconds: -1 },
      { seconds: 4.5 },
      { seconds: MAX_MEDIA_TIME_SECONDS + 1 },
      { seconds: '41' },
      {},
    ]) {
      expect(mediaTimeSeconds({ [field]: value })).toBeUndefined()
    }
    expect(mediaTimeSeconds(null)).toBeUndefined()
    expect(mediaTimeSeconds('text')).toBeUndefined()
  })
})

describe('eurosky: grouping counts into moments', () => {
  it('groups seconds by their counts, skipping empty ones', () => {
    expect(
      groupCountsIntoMoments([
        { seconds: 400, count: 4 },
        { seconds: 0, count: 2 },
        { seconds: 200, count: 1 },
        { seconds: 401, count: 0 },
        { seconds: 401, count: 3 },
      ]),
    ).toEqual([
      { startSeconds: 0, endSeconds: 0, replyCount: 2 },
      { startSeconds: 195, endSeconds: 200, replyCount: 1 },
      { startSeconds: 395, endSeconds: 401, replyCount: 7 },
    ])
  })
})

describe('eurosky: summary cache', () => {
  it('forgets entries after their time and drops the oldest when full', () => {
    let now = 0
    const cache = new TtlCache<number>({
      ttlMs: 1000,
      maxEntries: 2,
      now: () => now,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(2)
    now = 999
    expect(cache.get('b')).toBe(2)
    now = 1000
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeUndefined()
  })
})

describe('eurosky: grouping into moments', () => {
  let n = 0
  const r = (seconds: number) => ({
    uri: `at://did:plc:a/app.bsky.feed.post/${String(n++).padStart(4, '0')}` as AtUriString,
    seconds,
  })
  const spans = (seconds: number[]) =>
    groupIntoMoments(seconds.map(r)).map((m) => [
      m.startSeconds,
      m.endSeconds,
      m.replyCount,
    ])
  // two busy spots 38 seconds apart, with two replies between them
  const twoSpots = [
    60, 61, 62, 63, 64, 65, 66, 66, 80, 85, 98, 99, 100, 101, 102, 103, 104,
    104,
  ]

  it("starts a reply's moment 5 seconds before it, and not before 0", () => {
    expect(spans([41])).toEqual([[36, 41, 1]])
    expect(spans([2])).toEqual([[0, 2, 1]])
  })

  it('keeps two busy spots apart when a few replies lie between them', () => {
    // a 30-second gap between replies would have made this one moment
    expect(spans(twoSpots)).toEqual([
      [55, 80, 9],
      [82, 104, 9],
    ])
  })

  it('keeps a long, even stretch of replies as one moment', () => {
    const everyThreeSeconds = Array.from({ length: 31 }, (_, i) => 120 + 3 * i)
    expect(spans(everyThreeSeconds)).toEqual([[119, 210, 31]])
  })

  it('starts where replies pile up, not at a stray earlier reply', () => {
    expect(
      spans([100, 125, 125, 126, 126, 126, 127, 127, 128, 128, 128]),
    ).toEqual([[115, 128, 11]])
  })

  it('keeps replies far apart in separate moments', () => {
    expect(spans([200, 0])).toEqual([
      [0, 0, 1],
      [195, 200, 1],
    ])
  })

  it('groups counts like the replies they stand for', () => {
    const seconds = [...twoSpots, 0, 300, 301, 302]
    const perSecond = new Map<number, number>()
    for (const s of seconds) perSecond.set(s, (perSecond.get(s) ?? 0) + 1)
    expect(
      groupCountsIntoMoments(
        [...perSecond].map(([s, count]) => ({ seconds: s, count })),
      ),
    ).toEqual(
      groupIntoMoments(seconds.map(r)).map(
        ({ startSeconds, endSeconds, replyCount }) => ({
          startSeconds,
          endSeconds,
          replyCount,
        }),
      ),
    )
  })

  it('lists at most 100 replies per moment, by second, but counts all', () => {
    const replies = Array.from({ length: 150 }, (_, i) => r(10 + (i % 3)))
    const [moment] = groupIntoMoments(replies)
    expect(moment.replyCount).toBe(150)
    expect(moment.replies).toHaveLength(MAX_REPLIES_PER_MOMENT)
    expect(moment.replies.at(-1)?.seconds).toBe(11)
  })

  it('returns nothing for no replies', () => {
    expect(groupIntoMoments([])).toEqual([])
  })

  it("counts all replies by others the author hasn't answered, given the author", () => {
    const author = 'did:plc:author'
    const replies = [
      ...Array.from({ length: 150 }, (_, i) => r(10 + (i % 3))),
      { ...r(12), authorReplied: true },
      {
        uri: `at://${author}/app.bsky.feed.post/own` as AtUriString,
        seconds: 12,
      },
    ]
    const [moment] = groupIntoMoments(replies, { authorDid: author })
    expect(moment.replyCount).toBe(152)
    // past the 100 listed ones, without the answered one and the author's own
    expect(moment.unansweredCount).toBe(150)
    expect(groupIntoMoments(replies)[0]).not.toHaveProperty('unansweredCount')
  })
})
