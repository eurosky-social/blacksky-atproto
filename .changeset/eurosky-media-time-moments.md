---
'@atproto/bsky': patch
---

Add `network.eurosky.feed.getMoments` and `network.eurosky.feed.getMomentSummaries`: the moments of a video post, from its direct replies that carry a `network.eurosky.mediaTime` field (the second of the video a reply is about), grouped by that second. `getMomentSummaries` gives the counts for up to 25 posts at once, for feeds, and keeps each answer for a minute in memory. Read from the stored post records, so it needs no new table or index.
