import type { ServiceImpl } from '@connectrpc/connect'
import { sql } from 'kysely'
import type { Service } from '../../../proto/bsky_connect.js'
import type { Database } from '../db/index.js'

// Eurosky: replies to a video post that name a second of the video. The
// indexer keeps them in post_media_time (see indexing/media-time.ts), so a
// video with thousands of ordinary replies costs no more than one without.

export const MAX_MEDIA_TIME_REPLIES = 10_000
export const MAX_MEDIA_TIME_COUNT_POSTS = 25

export default (db: Database): Partial<ServiceImpl<typeof Service>> => ({
  async getMediaTimeReplies(req) {
    const { postUri } = req
    if (!postUri) return { replies: [], truncated: false }
    const limit = Math.min(
      Math.max(req.limit || MAX_MEDIA_TIME_REPLIES, 1),
      MAX_MEDIA_TIME_REPLIES,
    )
    const rows = await visibleMediaTimes(db, [postUri])
      .select(['linked.postUri as uri', 'linked.seconds'])
      .orderBy('linked.seconds')
      .orderBy('linked.postUri')
      .limit(limit + 1)
      .execute()
    return {
      replies: rows
        .slice(0, limit)
        .map((row) => ({ uri: row.uri, seconds: row.seconds })),
      truncated: rows.length > limit,
    }
  },

  // Linked replies per second, for several posts. Counted, not listed, so a
  // busy video costs one row per second that has comments.
  async getMediaTimeCounts(req) {
    const postUris = [...new Set(req.postUris.filter(Boolean))].slice(
      0,
      MAX_MEDIA_TIME_COUNT_POSTS,
    )
    if (postUris.length === 0) return { counts: [] }
    const rows = await visibleMediaTimes(db, postUris)
      .select([
        'linked.parentUri',
        'linked.seconds',
        sql<string>`count(*)`.as('count'),
      ])
      .groupBy(['linked.parentUri', 'linked.seconds'])
      .execute()
    return {
      counts: rows.map((row) => ({
        postUri: row.parentUri,
        seconds: row.seconds,
        count: Number(row.count),
      })),
    }
  },
})

/**
 * Linked direct replies to `postUris`, as `linked`. Leaves out what the
 * AppView would not show: deleted posts, taken-down records, taken-down or
 * inactive accounts, replies against the thread's reply rules.
 */
function visibleMediaTimes(db: Database, postUris: string[]) {
  return db.db
    .selectFrom('post_media_time as linked')
    .innerJoin('post', 'post.uri', 'linked.postUri')
    .innerJoin('record', 'record.uri', 'linked.postUri')
    .innerJoin('actor', 'actor.did', 'post.creator')
    .where('linked.parentUri', 'in', postUris)
    .where('record.takedownRef', 'is', null)
    .where('actor.takedownRef', 'is', null)
    .where((eb) =>
      eb.or([
        eb('actor.upstreamStatus', 'is', null),
        eb('actor.upstreamStatus', '=', 'active'),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('post.violatesThreadGate', 'is', null),
        eb('post.violatesThreadGate', '=', false),
      ]),
    )
}
