import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestNetwork } from '@atproto/dev-env'

// getKnownLikers ("liked by people you follow"). Upstream keeps the viewer's
// follows among each post's 500 newest likes, which is only fast with
// like_subject_sort_at_creator_idx, and juice doesn't build that index. The
// dataplane-known-likers-follow-first patch starts from the viewer's newest
// 5,000 follows instead and looks them up in like_unique_subject.

describe('eurosky: known likers start from the viewer’s follows', () => {
  let network: TestNetwork

  const viewer = 'did:plc:viewer'
  const heavyViewer = 'did:plc:heavy-viewer'
  const viralPost = 'at://did:plc:author/app.bsky.feed.post/viral'
  const capPost = 'at://did:plc:author/app.bsky.feed.post/cap'
  const spacePost = 'at://did:plc:author/app.bsky.feed.post/space'
  const earlyFan = 'did:plc:early-fan'
  const lateFan = 'did:plc:late-fan'
  const followCount = 5001

  beforeAll(async () => {
    network = await TestNetwork.create({
      dbPostgresSchema: 'bsky_eurosky_known_likers',
    })
    const { db } = network.bsky.db

    await db
      .insertInto('follow')
      .values([
        follow(viewer, earlyFan, 0),
        follow(viewer, lateFan, 1),
        ...Array.from({ length: followCount }, (_, i) =>
          follow(heavyViewer, followed(i), i),
        ),
      ])
      .execute()

    await db
      .insertInto('like')
      .values([
        // 600 likes: the viewer's follows gave the oldest and the newest.
        ...Array.from({ length: 600 }, (_, i) =>
          like(
            viralPost,
            i === 0 ? earlyFan : i === 599 ? lateFan : `did:plc:stranger-${i}`,
            i,
          ),
        ),
        // the heavy viewer's oldest and newest follow
        like(capPost, followed(0), 1000),
        like(capPost, followed(followCount - 1), 1001),
        // one like inside a space, one outside
        { ...like(spacePost, earlyFan, 2000), space_uri: 'at://did:plc:space' },
        like(spacePost, lateFan, 2001),
      ])
      .execute()
  })

  afterAll(async () => network?.close())

  it('counts followed likers older than the 500 newest likes', async () => {
    const { results } = await network.bsky.ctx.dataplane.getKnownLikers({
      actorDid: viewer,
      subjectUris: [viralPost],
      limit: 3,
    })
    expect(results).toEqual([
      { subjectUri: viralPost, count: 2, dids: [lateFan, earlyFan] },
    ])
  })

  it('checks only the viewer’s 5,000 newest follows', async () => {
    const { results } = await network.bsky.ctx.dataplane.getKnownLikers({
      actorDid: heavyViewer,
      subjectUris: [capPost],
      limit: 3,
    })
    expect(results).toEqual([
      { subjectUri: capPost, count: 1, dids: [followed(followCount - 1)] },
    ])
  })

  it('leaves likes inside a space out', async () => {
    const { results } = await network.bsky.ctx.dataplane.getKnownLikers({
      actorDid: viewer,
      subjectUris: [spacePost, viralPost],
      limit: 1,
    })
    expect(results).toEqual([
      { subjectUri: spacePost, count: 1, dids: [lateFan] },
      { subjectUri: viralPost, count: 2, dids: [lateFan] },
    ])
  })
})

function followed(i: number) {
  return `did:plc:followed-${i}`
}

function follow(creator: string, subjectDid: string, order: number) {
  return {
    uri: `at://${creator}/app.bsky.graph.follow/${order}`,
    cid: `follow-cid-${creator}-${order}`,
    creator,
    subjectDid,
    createdAt: timestamp(order),
    indexedAt: timestamp(order),
  }
}

function like(subject: string, creator: string, order: number) {
  return {
    uri: `at://${creator}/app.bsky.feed.like/${order}`,
    cid: `like-cid-${order}`,
    creator,
    subject,
    subjectCid: 'subject-cid',
    via: null,
    viaCid: null,
    createdAt: timestamp(order),
    indexedAt: timestamp(order),
  }
}

function timestamp(order: number) {
  return new Date(Date.UTC(2020, 0, 1, 0, 0, order)).toISOString()
}
