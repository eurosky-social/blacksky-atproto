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

export default (db: Database): Partial<ServiceImpl<typeof Service>> => ({
  async getMediaTimeReplies(req) {
    const { postUri } = req
    if (!postUri) return { replies: [], truncated: false }
    const limit = Math.min(
      Math.max(req.limit || MAX_MEDIA_TIME_REPLIES, 1),
      MAX_MEDIA_TIME_REPLIES,
    )

    // post_replyparent_idx finds the direct replies; the LIKE skips parsing
    // records that cannot carry the field. Invalid values are dropped here,
    // not after the limit, so they don't use it up.
    const linked = db.db
      .selectFrom('post')
      .innerJoin('record', 'record.uri', 'post.uri')
      .innerJoin('actor', 'actor.did', 'post.creator')
      .where('post.replyParent', '=', postUri)
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
        sql`"record"."json"::jsonb -> ${MEDIA_TIME_FIELD}::text`.as('value'),
      ])
      .as('linked')

    // Postgres may test conditions in any order; the CASE keeps the cast
    // away from values that are not numbers.
    const seconds = sql<string | null>`case
      when jsonb_typeof("linked"."value" -> 'seconds') = 'number'
      then ("linked"."value" ->> 'seconds')::numeric
    end`
    const rows = await db.db
      .selectFrom(linked)
      .where(
        sql<boolean>`coalesce("linked"."value" ->> '$type', ${MEDIA_TIME_FIELD}::text) = ${MEDIA_TIME_FIELD}::text`,
      )
      .where(sql<boolean>`${seconds} between 0 and ${MAX_MEDIA_TIME_SECONDS}`)
      .where(sql<boolean>`${seconds} % 1 = 0`)
      .select(['linked.uri', sql<number>`(${seconds})::int`.as('seconds')])
      .limit(limit + 1)
      .execute()

    return {
      replies: rows
        .slice(0, limit)
        .map((row) => ({ uri: row.uri, seconds: row.seconds })),
      truncated: rows.length > limit,
    }
  },
})
