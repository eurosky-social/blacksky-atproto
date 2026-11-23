import assert from 'node:assert'
import type { ServiceImpl } from '@connectrpc/connect'
import { sql } from 'kysely'
import { keyBy } from '@atproto/common'
import {
  isSpaceRecordUri,
  spaceOfRecordUri,
} from '../../../api/community/blacksky/space-uri.js'
import type { Service } from '../../../proto/bsky_connect.js'
import type { Database } from '../db/index.js'
import { TimeCidKeyset, paginate } from '../db/pagination.js'

// Eurosky: how many of the viewer's newest follows getKnownLikers checks. Its
// cost grows with the follows checked, so this bounds it for accounts that
// follow tens of thousands; an older follow's like then goes uncounted.
const KNOWN_LIKERS_MAX_FOLLOWS = 5000

export default (db: Database): Partial<ServiceImpl<typeof Service>> => ({
  async getKnownLikers(req) {
    const { actorDid, subjectUris, limit } = req
    const results = subjectUris.map((subjectUri) => ({
      subjectUri,
      count: 0,
      dids: [] as string[],
    }))
    if (limit <= 0 || subjectUris.length === 0) return { results }

    // Eurosky (dataplane-known-likers-follow-first): upstream keeps the
    // viewer's follows among each subject's 500 newest likes, which is only
    // fast with like_subject_sort_at_creator_idx. juice doesn't build that
    // index (dataplane-like-index-by-hand), and without it Postgres reads
    // every like of a subject to find the newest 500. Instead, ask
    // like_unique_subject (subject, creator) for any of the subjects liked by
    // any of the viewer's newest follows, in one pass. count is every followed
    // liker, not only those among the 500 newest likes.
    const { rows } = await sql<{
      subject: string
      creator: string
      count: number
    }>`
      with "knownLikes" as (
        select "like".subject, "like".creator, "like"."sortAt"
        from "like"
        where "like".subject = any(${subjectUris}::varchar[])
          and "like".creator = any(array(
            select follow."subjectDid"
            from follow
            where follow.creator = ${actorDid}
            order by follow."sortAt" desc
            limit ${KNOWN_LIKERS_MAX_FOLLOWS}
          ))
          and "like".space_uri is null
      ),
      "rankedKnownLikers" as (
        select
          subject,
          creator,
          count(*) over (partition by subject)::int as count,
          row_number() over (
            partition by subject
            order by "sortAt" desc
          ) as rank
        from "knownLikes"
      )
      select subject, creator, count
      from "rankedKnownLikers"
      where rank <= ${limit}
      order by subject, rank
    `.execute(db.db)

    const bySubject = new Map<string, { count: number; dids: string[] }>()
    for (const row of rows) {
      const known = bySubject.get(row.subject) ?? { count: row.count, dids: [] }
      known.dids.push(row.creator)
      bySubject.set(row.subject, known)
    }
    for (const result of results) {
      const known = bySubject.get(result.subjectUri)
      if (!known) continue
      result.count = known.count
      result.dids.push(...known.dids)
    }
    return { results }
  },

  async getLikesBySubjectSorted(req) {
    const { subject, cursor, limit } = req
    const { ref } = db.db.dynamic

    if (!subject?.uri) {
      return { uris: [] }
    }

    // @NOTE ignoring subject.cid
    let builder = db.db
      .selectFrom('like')
      .where('like.subject', '=', subject?.uri)
      .where('like.space_uri', 'is', null)
      .selectAll('like')

    const keyset = new TimeCidKeyset(ref('like.sortAt'), ref('like.cid'))
    builder = paginate(builder, {
      limit,
      cursor,
      keyset,
    })

    const page = keyset.page(await builder.execute(), limit)

    return {
      uris: page.items.map((l) => l.uri),
      cursor: page.cursor,
    }
  },

  async getSpacePostLikes(req) {
    const { subject, cursor, limit } = req
    const spaceUri = subject?.uri ? spaceOfRecordUri(subject.uri) : null
    if (!subject?.uri || !isSpaceRecordUri(subject.uri) || !spaceUri) {
      return { likes: [] }
    }

    const { ref } = db.db.dynamic
    let builder = db.db
      .selectFrom('like')
      .where('like.subject', '=', subject.uri)
      .where('like.space_uri', '=', spaceUri)
      .select([
        'like.uri',
        'like.creator',
        'like.createdAt',
        'like.indexedAt',
        'like.sortAt',
        'like.cid',
      ])
    if (subject.cid) {
      builder = builder.where('like.subjectCid', '=', subject.cid)
    }

    const keyset = new TimeCidKeyset(ref('like.sortAt'), ref('like.cid'))
    builder = paginate(builder, { limit, cursor, keyset })
    const page = keyset.page(await builder.execute(), limit)

    return {
      likes: page.items.map((like) => ({
        uri: like.uri,
        creator: like.creator,
        createdAt: like.createdAt,
        indexedAt: like.indexedAt,
      })),
      cursor: page.cursor,
    }
  },

  // @NOTE deprecated in favor of getLikesBySubjectSorted
  async getLikesBySubject(req, context) {
    assert(this.getLikesBySubjectSorted)
    return this.getLikesBySubjectSorted(req, context)
  },

  async getLikesByActorAndSubjects(req) {
    const { actorDid, refs } = req
    if (refs.length === 0) {
      return { uris: [] }
    }
    // @NOTE ignoring ref.cid
    const res = await db.db
      .selectFrom('like')
      .where('creator', '=', actorDid)
      .where('space_uri', 'is', null)
      .where(
        'subject',
        'in',
        refs.map(({ uri }) => uri),
      )
      .selectAll()
      .execute()
    const bySubject = keyBy(res, 'subject')
    const uris = refs.map(({ uri }) => bySubject.get(uri)?.uri ?? '')
    return { uris }
  },

  async getActorLikes(req) {
    const { actorDid, limit, cursor } = req
    const { ref } = db.db.dynamic

    let builder = db.db
      .selectFrom('like')
      .where('like.creator', '=', actorDid)
      .where('like.space_uri', 'is', null)
      .selectAll()

    const keyset = new TimeCidKeyset(ref('like.sortAt'), ref('like.cid'))

    builder = paginate(builder, {
      limit,
      cursor,
      keyset,
    })

    const page = keyset.page(await builder.execute(), limit)

    return {
      likes: page.items.map((l) => ({
        uri: l.uri,
        subject: l.subject,
      })),
      cursor: page.cursor,
    }
  },
})
