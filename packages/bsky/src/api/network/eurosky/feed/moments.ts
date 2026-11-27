// Eurosky: grouping of a video's linked replies into moments. mu groups the
// same way when the AppView doesn't answer (eurosky-social-app
// src/features/mediaTime/moments.ts); keep the two alike.
//
// Every reply adds a bell-shaped bump to a curve along the video, and the
// moments are the hills of that curve: where replies pile up. A stretch of
// steady replies between two busy spots no longer joins them into one
// moment, as a fixed gap between replies did.

import type { AtUriString } from '@atproto/syntax'

/**
 * How wide one reply's bump is, in seconds (its standard deviation). One
 * reply alone makes a hill 1 high.
 */
export const MOMENT_BUMP_SECONDS = 10
/**
 * Two neighbouring hills are two moments only where the curve between them
 * dips at least this share below the lower of their tops.
 */
export const MOMENT_SPLIT_DIP = 0.3
/** A moment starts where its hill rises above this share of its height, */
export const MOMENT_RISE = 0.5
/** but at most this many seconds before its first reply. */
export const MOMENT_LEAD_SECONDS = 5
/** A bump counts as zero this many seconds from its reply. */
const BUMP_REACH_SECONDS = 4 * MOMENT_BUMP_SECONDS

export const MAX_REPLIES_PER_MOMENT = 100

export type MediaTimeReply = {
  uri: AtUriString
  seconds: number
  /** The video post's author replied directly to this reply. */
  authorReplied?: boolean
}

export type MediaTimeCount = { seconds: number; count: number }

export type MomentSummary = {
  /** Where to start playing. Can be before or after the first reply. */
  startSeconds: number
  /** The second of the moment's latest reply. */
  endSeconds: number
  replyCount: number
}

export type Moment = MomentSummary & {
  replies: MediaTimeReply[]
  /**
   * How many of the moment's replies by others the video post's author has
   * not replied to directly. Only when grouped with the author's DID.
   */
  unansweredCount?: number
}

/** A moment and the last second that belongs to it. */
type Found = MomentSummary & { until: number }

/**
 * Groups replies into moments, in order of time. Each moment lists at most
 * `MAX_REPLIES_PER_MOMENT` replies, by second; `replyCount` counts all of
 * them. Given the video post's author (`authorDid`), each moment also counts
 * the replies by others that the author hasn't replied to.
 */
export function groupIntoMoments(
  replies: readonly MediaTimeReply[],
  { authorDid }: { authorDid?: string } = {},
): Moment[] {
  const byAuthor = authorDid ? `at://${authorDid}/` : undefined
  const sorted = [...replies].sort(
    (a, b) =>
      a.seconds - b.seconds || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
  )
  const perSecond = new Map<number, number>()
  for (const { seconds } of sorted) {
    perSecond.set(seconds, (perSecond.get(seconds) ?? 0) + 1)
  }
  const found = findMoments(
    [...perSecond].map(([seconds, count]) => ({ seconds, count })),
  )
  let next = 0
  return found.map((moment) => {
    const listed: MediaTimeReply[] = []
    let unansweredCount = 0
    while (next < sorted.length && sorted[next].seconds <= moment.until) {
      const { uri, seconds, authorReplied } = sorted[next]
      if (listed.length < MAX_REPLIES_PER_MOMENT) {
        listed.push(
          authorReplied ? { uri, seconds, authorReplied } : { uri, seconds },
        )
      }
      if (byAuthor && !authorReplied && !uri.startsWith(byAuthor)) {
        unansweredCount++
      }
      next++
    }
    return {
      ...summaryOf(moment),
      ...(byAuthor ? { unansweredCount } : {}),
      replies: listed,
    }
  })
}

/** The same grouping as `groupIntoMoments`, from the number of replies at each second. */
export function groupCountsIntoMoments(
  counts: readonly MediaTimeCount[],
): MomentSummary[] {
  return findMoments(counts).map(summaryOf)
}

function summaryOf({
  startSeconds,
  endSeconds,
  replyCount,
}: Found): MomentSummary {
  return { startSeconds, endSeconds, replyCount }
}

function findMoments(counts: readonly MediaTimeCount[]): Found[] {
  const sorted = counts
    .filter((c) => c.count > 0)
    .sort((a, b) => a.seconds - b.seconds)
  // Bumps of replies further apart than this never touch, so each stretch
  // of nearby replies gets a curve of its own. That keeps the curve short
  // when a long video has replies at both ends.
  const found: Found[] = []
  let from = 0
  for (let i = 1; i <= sorted.length; i++) {
    if (
      i === sorted.length ||
      sorted[i].seconds - sorted[i - 1].seconds > 2 * BUMP_REACH_SECONDS
    ) {
      found.push(...hillsOf(sorted.slice(from, i)))
      from = i
    }
  }
  return found
}

/** The moments of a stretch of replies, sorted by second, none empty. */
function hillsOf(counts: readonly MediaTimeCount[]): Found[] {
  const first = counts[0].seconds
  const last = counts[counts.length - 1].seconds
  const lo = Math.max(0, first - BUMP_REACH_SECONDS)
  const curve = new Float64Array(last + BUMP_REACH_SECONDS - lo + 1)
  const spread = 2 * MOMENT_BUMP_SECONDS ** 2
  for (const { seconds, count } of counts) {
    const to = seconds + BUMP_REACH_SECONDS
    for (let t = Math.max(lo, seconds - BUMP_REACH_SECONDS); t <= to; t++) {
      curve[t - lo] += count * Math.exp(-((t - seconds) ** 2) / spread)
    }
  }

  // The tops of the hills (the first of equal neighbours), and the lowest
  // point between each two neighbouring tops. Indexes into `curve`.
  const tops: number[] = []
  for (let i = 0; i < curve.length; i++) {
    const left = i > 0 ? curve[i - 1] : -Infinity
    const right = i < curve.length - 1 ? curve[i + 1] : -Infinity
    if (curve[i] > left && curve[i] >= right) tops.push(i)
  }
  const dips: number[] = []
  for (let k = 0; k + 1 < tops.length; k++) {
    let low = tops[k]
    for (let i = tops[k]; i <= tops[k + 1]; i++) {
      if (curve[i] < curve[low]) low = i
    }
    dips.push(low)
  }

  // Join neighbouring hills across dips that are too shallow, the
  // shallowest first; the joined hill keeps the higher top.
  for (;;) {
    let join = -1
    let joinRatio = 1 - MOMENT_SPLIT_DIP
    for (let k = 0; k < dips.length; k++) {
      const lowerTop = Math.min(curve[tops[k]], curve[tops[k + 1]])
      const ratio = curve[dips[k]] / lowerTop
      if (ratio > joinRatio) {
        join = k
        joinRatio = ratio
      }
    }
    if (join < 0) break
    const higher =
      curve[tops[join]] >= curve[tops[join + 1]] ? tops[join] : tops[join + 1]
    tops.splice(join, 2, higher)
    dips.splice(join, 1)
  }

  // Each second belongs to the hill between the dips around it.
  const found: Found[] = []
  let next = 0
  tops.forEach((top, k) => {
    const until = k < dips.length ? dips[k] + lo : last
    let replyCount = 0
    let firstSecond = -1
    let lastSecond = -1
    while (next < counts.length && counts[next].seconds <= until) {
      if (firstSecond < 0) firstSecond = counts[next].seconds
      lastSecond = counts[next].seconds
      replyCount += counts[next].count
      next++
    }
    if (replyCount === 0) return
    const leftEdge = k > 0 ? dips[k - 1] : 0
    let rise = top
    while (rise > leftEdge && curve[rise - 1] >= MOMENT_RISE * curve[top]) {
      rise--
    }
    const start = Math.max(0, rise + lo, firstSecond - MOMENT_LEAD_SECONDS)
    found.push({
      startSeconds: Math.min(start, lastSecond),
      endSeconds: lastSecond,
      replyCount,
      until,
    })
  })
  return found
}
