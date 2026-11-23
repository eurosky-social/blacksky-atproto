---
'@atproto/bsky': patch
---

Answer a cursor the dataplane cannot read with a 400 instead of a 500, and continue from a bare ISO time cursor (as Bluesky's AppView sends for feeds and likes) instead of rejecting it
