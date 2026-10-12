### The media plane, in development (MediaMTX)

`compose.media.yaml` is its own compose project, `arthome-media`, never the infrastructure's: a
MediaMTX origin (ingest), a MediaMTX edge (the CDN's twin) and Envoy checking the playback token on
every request. The streaming API asks nothing of it until `STREAMING_MEDIA_PROVIDER=mediamtx` and the
`MEDIAMTX_*` URLs are set (`apps/streaming/.env.example`); the fake stays the default.

```bash
export MTX_AUTHHTTPADDRESS="http://mediamtx:${MEDIA_SERVER_SECRET:-development-media-server-secret-not-for-production}@host.docker.internal:3005/v1/media-server/authorize"
docker compose -f compose.media.yaml up -d
```

The origin asks the streaming API's `authorizeMediaServerAccess` before each publish, so the API
must listen on 3005 first. The fallback is the API's own development secret: a password that differs
from the API's answers 401 to every publish. After regenerating the playback key set (`node tools/playback-jwks.mjs`),
restart `playback-edge`: Envoy reads it at start only. Ports, publishing from OBS, and what the
suites prove: `apps/streaming/HANDOVER.md` §0h. The suites start the same images with
`startMediaStack` (`libs/testing`), never this project.

