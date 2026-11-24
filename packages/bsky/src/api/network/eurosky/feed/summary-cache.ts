// Eurosky: a small in-process cache for moment summaries. Feeds show the
// same popular video to many people; without it each impression would read
// all of the video's direct replies again.

export type TtlCacheOptions = {
  ttlMs: number
  maxEntries: number
  now?: () => number
}

export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>()
  private now: () => number

  constructor(private opts: TtlCacheOptions) {
    this.now = opts.now ?? Date.now
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T) {
    // Map keeps insertion order: re-inserting moves the key to the end, and
    // the first key is the oldest.
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.opts.ttlMs })
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size() {
    return this.entries.size
  }
}
