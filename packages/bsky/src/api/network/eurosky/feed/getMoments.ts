import type { AtUriString } from '@atproto/syntax'
import type { Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { network } from '../../../../lexicons/index.js'
import { groupIntoMoments } from './moments.js'

// Eurosky: moments of a video post, from its direct replies that name a
// second of the video (network.eurosky.mediaTime). Public data; the answer
// does not depend on who asks, so the endpoint takes no auth.
export default function (server: Server, ctx: AppContext) {
  server.add(network.eurosky.feed.getMoments, async ({ params }) => {
    const { replies, truncated } = await ctx.dataplane.getMediaTimeReplies({
      postUri: params.uri,
    })
    return {
      encoding: 'application/json',
      body: {
        uri: params.uri,
        replyCount: replies.length,
        truncated: truncated || undefined,
        moments: groupIntoMoments(
          replies.map(({ uri, seconds }) => ({
            uri: uri as AtUriString,
            seconds,
          })),
        ),
      },
    }
  })
}
