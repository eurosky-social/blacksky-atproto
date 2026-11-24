---
'@atproto/bsky': patch
---

The notification push bridge no longer pushes notifications older than `BSKY_NOTIFICATION_PUSH_MAX_AGE_MINUTES` (default 60; 0 pushes every notification). A repository read again later lists its old likes and follows at their own time without pushing them.
