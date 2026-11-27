import { AtUri, type AtUriString } from '@atproto/syntax'
import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { network } from '../../../../lexicons/index.js'
import { type Moment, groupIntoMoments } from './moments.js'
import { TtlCache } from './summary-cache.js'

type Moments = { replyCount: number; truncated?: true; moments: Moment[] }

export const MOMENTS_CACHE_TTL_MS = 30_000

// Eurosky: moments of a video post, from its direct replies that name a
// second of the video (network.eurosky.mediaTime). Public data; the answer
// does not depend on who asks, so the endpoint takes no auth. Each post's
// answer is kept for 30 seconds in this process, and requests that arrive
// while it is being read share that read.
export default function (server: Server, ctx: AppContext) {
  const cache = new TtlCache<Promise<Moments>>({
    ttlMs: MOMENTS_CACHE_TTL_MS,
    maxEntries: 1_000,
  })

  const load = async (uri: string): Promise<Moments> => {
    const { replies, truncated } = await ctx.dataplane.getMediaTimeReplies({
      postUri: uri,
    })
    return {
      replyCount: replies.length,
      truncated: truncated || undefined,
      moments: groupIntoMoments(
        replies.map(({ uri, seconds, authorReplied }) => ({
          uri: uri as AtUriString,
          seconds,
          authorReplied,
        })),
        { authorDid: authorOf(uri) },
      ),
    }
  }

  server.add(network.eurosky.feed.getMoments, async ({ params }) => {
    let pending = cache.get(params.uri)
    if (!pending) {
      const read = load(params.uri)
      cache.set(params.uri, read)
      // a failed read is not kept; the next request tries again
      read.catch(() => {
        if (cache.get(params.uri) === read) cache.delete(params.uri)
      })
      pending = read
    }
    const moments = await pending
    return {
      encoding: 'application/json',
      body: { uri: params.uri, ...moments },
    }
  })
}

/** The DID a post's URI names, if it names one. */
function authorOf(uri: string): string | undefined {
  try {
    const { host } = new AtUri(uri)
    return host.startsWith('did:') ? host : undefined
  } catch {
    return undefined
  }
}
