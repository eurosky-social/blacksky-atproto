import type { AtUriString } from '@atproto/syntax'
import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { network } from '../../../../lexicons/index.js'
import {
  type MediaTimeCount,
  type MomentSummary,
  groupCountsIntoMoments,
} from './moments.js'
import { TtlCache } from './summary-cache.js'

type Summary = { replyCount: number; moments: MomentSummary[] }

// Eurosky: moment counts for the video posts in a feed page. Public data,
// no auth. Each post's answer is cached for a minute in this process.
export default function (server: Server, ctx: AppContext) {
  const cache = new TtlCache<Summary>({ ttlMs: 60_000, maxEntries: 20_000 })

  server.add(network.eurosky.feed.getMomentSummaries, async ({ params }) => {
    const uris = [...new Set(params.uris)]
    const missing = uris.filter((uri) => cache.get(uri) === undefined)
    if (missing.length > 0) {
      const { counts } = await ctx.dataplane.getMediaTimeCounts({
        postUris: missing,
      })
      const byPost = new Map<string, MediaTimeCount[]>()
      for (const { postUri, seconds, count } of counts) {
        const list = byPost.get(postUri) ?? []
        list.push({ seconds, count })
        byPost.set(postUri, list)
      }
      for (const uri of missing) {
        const moments = groupCountsIntoMoments(byPost.get(uri) ?? [])
        cache.set(uri, {
          replyCount: moments.reduce((sum, m) => sum + m.replyCount, 0),
          moments,
        })
      }
    }
    return {
      encoding: 'application/json',
      body: {
        summaries: params.uris.map((uri) => {
          const summary = cache.get(uri) ?? { replyCount: 0, moments: [] }
          return { uri: uri as AtUriString, ...summary }
        }),
      },
    }
  })
}
