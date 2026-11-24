---
'@atproto/bsky': patch
---

Add `network.eurosky.feed.getMoments`: the moments of a video post, from its direct replies that carry a `network.eurosky.mediaTime` field (the second of the video a reply is about), grouped by that second. Read from the stored post records, so it needs no new table or index.
