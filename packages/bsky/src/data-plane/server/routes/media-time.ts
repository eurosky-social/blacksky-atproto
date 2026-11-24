import type { ServiceImpl } from '@connectrpc/connect'
import { sql } from 'kysely'
import type { Service } from '../../../proto/bsky_connect.js'
import type { Database } from '../db/index.js'

// Eurosky: a reply to a video post can name the second of the video it is
// about, in an extra field on the post record:
//   "network.eurosky.mediaTime": {"$type": "network.eurosky.mediaTime", "seconds": 41}
// The field is not indexed on its own; it is read from the stored record.

export const MEDIA_TIME_FIELD = 'network.eurosky.mediaTime'
// 100 hours, the same limit the app applies when writing the field.
export const MAX_MEDIA_TIME_SECONDS = 360_000
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
    const rows = await validMediaTimes(db, [postUri])
      .select(['linked.uri', sql<number>`(${secondsOf})::int`.as('seconds')])
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
    const seconds = sql<number>`(${secondsOf})::int`
    const rows = await validMediaTimes(db, postUris)
      .select([
        'linked.parent',
        seconds.as('seconds'),
        sql<string>`count(*)`.as('count'),
      ])
      .groupBy(['linked.parent', seconds])
      .execute()
    return {
      counts: rows.map((row) => ({
        postUri: row.parent,
        seconds: row.seconds,
        count: Number(row.count),
      })),
    }
  },
})

// The seconds of a linked reply. Postgres may test conditions in any order;
// the CASE keeps the cast away from values that are not numbers.
const secondsOf = sql<string | null>`case
  when jsonb_typeof("linked"."value" -> 'seconds') = 'number'
  then ("linked"."value" ->> 'seconds')::numeric
end`

/**
 * Direct replies to `postUris` with a valid media time, as `linked`. Leaves
 * out what the AppView would not show: taken-down records, taken-down or
 * inactive accounts, replies against the thread's reply rules. Invalid
 * values are dropped here, so they don't use up a caller's limit.
 */
function validMediaTimes(db: Database, postUris: string[]) {
  // post_replyparent_idx finds the direct replies; the LIKE skips parsing
  // records that cannot carry the field.
  const linked = db.db
    .selectFrom('post')
    .innerJoin('record', 'record.uri', 'post.uri')
    .innerJoin('actor', 'actor.did', 'post.creator')
    .where('post.replyParent', 'in', postUris)
    .where('record.json', 'like', `%"${MEDIA_TIME_FIELD}"%`)
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
    .select([
      'post.uri',
      sql<string>`"post"."replyParent"`.as('parent'),
      sql`"record"."json"::jsonb -> ${MEDIA_TIME_FIELD}::text`.as('value'),
    ])
    .as('linked')

  return db.db
    .selectFrom(linked)
    .where(
      sql<boolean>`coalesce("linked"."value" ->> '$type', ${MEDIA_TIME_FIELD}::text) = ${MEDIA_TIME_FIELD}::text`,
    )
    .where(sql<boolean>`${secondsOf} between 0 and ${MAX_MEDIA_TIME_SECONDS}`)
    .where(sql<boolean>`${secondsOf} % 1 = 0`)
}
