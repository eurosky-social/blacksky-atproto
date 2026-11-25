---
'@atproto/bsky': patch
---

Eurosky: `network.eurosky.feed.getMoments` and `getMomentSummaries` group a video's linked replies by where they pile up (the hills of a curve along the video) instead of by a 30-second gap between replies, and a moment starts just before its replies do.
