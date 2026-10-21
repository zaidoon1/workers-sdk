---
"wrangler": patch
"@cloudflare/vite-plugin": patch
---

Leave local Container cleanup to workerd

Wrangler and the Vite plugin no longer scan Docker for containers by image tag. They wait for Miniflare to shut down workerd, which removes the application containers, networking sidecars, and snapshot volumes it created.
