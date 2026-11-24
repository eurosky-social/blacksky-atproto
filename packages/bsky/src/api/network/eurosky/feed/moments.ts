// Eurosky: grouping of a video's linked replies into moments. mu groups the
// same way when it falls back to the replies of a loaded thread
// (eurosky-social-app src/features/mediaTime/moments.ts); keep the two alike.

import type { AtUriString } from '@atproto/syntax'

/** A reply more than this many seconds after the previous one starts a new moment. */
export const MOMENT_GAP_SECONDS = 30
export const MAX_REPLIES_PER_MOMENT = 100

export type MediaTimeReply = { uri: AtUriString; seconds: number }

export type Moment = {
  startSeconds: number
  endSeconds: number
  replyCount: number
  replies: MediaTimeReply[]
}

/**
 * Sorts replies by second and starts a new moment wherever the gap to the
 * previous reply is larger than `gapSeconds`. Each moment lists at most
 * `MAX_REPLIES_PER_MOMENT` replies; `replyCount` counts all of them.
 */
export function groupIntoMoments(
  replies: readonly MediaTimeReply[],
  gapSeconds = MOMENT_GAP_SECONDS,
): Moment[] {
  const sorted = [...replies].sort(
    (a, b) =>
      a.seconds - b.seconds || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
  )
  const moments: Moment[] = []
  let current: Moment | undefined
  for (const reply of sorted) {
    if (!current || reply.seconds - current.endSeconds > gapSeconds) {
      current = {
        startSeconds: reply.seconds,
        endSeconds: reply.seconds,
        replyCount: 0,
        replies: [],
      }
      moments.push(current)
    }
    current.endSeconds = reply.seconds
    current.replyCount += 1
    if (current.replies.length < MAX_REPLIES_PER_MOMENT) {
      current.replies.push({ uri: reply.uri, seconds: reply.seconds })
    }
  }
  return moments
}
