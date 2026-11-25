// Eurosky: a reply to a video post can name the second of the video it is
// about, in an extra field on the post record:
//   "network.eurosky.mediaTime": {"$type": "network.eurosky.mediaTime", "seconds": 41}
// The indexer keeps valid values in post_media_time. rsky-wintermute applies
// the same rules in production (indexer/media_time.rs).

export const MEDIA_TIME_FIELD = 'network.eurosky.mediaTime'
// 100 hours, the same limit the app applies when writing the field.
export const MAX_MEDIA_TIME_SECONDS = 360_000

/** The second a post record names, or undefined when it names none. */
export function mediaTimeSeconds(record: unknown): number | undefined {
  if (!record || typeof record !== 'object') return undefined
  const value = (record as Record<string, unknown>)[MEDIA_TIME_FIELD]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const { $type, seconds } = value as { $type?: unknown; seconds?: unknown }
  if ($type !== undefined && $type !== MEDIA_TIME_FIELD) return undefined
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)) {
    return undefined
  }
  if (seconds < 0 || seconds > MAX_MEDIA_TIME_SECONDS) return undefined
  return seconds
}
