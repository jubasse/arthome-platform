#!/bin/sh
# The compatibility worker (streaming.md §6): a browser's Opus becomes the AAC that HLS carries,
# video copied, never transcoded. Run by the edge through a `watch/<dateId>` path's `runOnInit`.
#
#   audio-worker.sh <origin RTSP URL of live/<streamPath>> <edge path watch/<dateId>>
#
# A lost input is retried for GRACE_S with the edge path kept alive (`alwaysAvailable`), then at
# 1, 2 and 4 s, then the worker exits: never an endless restart. The streaming API declares the
# failure when the feed is online and the edge path stayed offline past that budget.

set -u

source_url="$1"
edge_url="rtsp://127.0.0.1:${RTSP_PORT:-8554}/$2"
GRACE_S="${AUDIO_WORKER_GRACE_S:-5}"

relay() {
  ffmpeg -hide_banner -loglevel error -nostdin \
    -fflags nobuffer -flags low_delay -max_delay 100000 \
    -rtsp_transport tcp -i "$source_url" \
    -map 0:v:0 -map 0:a:0 -c:v copy \
    -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -f rtsp -rtsp_transport tcp "$edge_url"
}

# True when the relay ran, so its input was there and was lost: a new grace starts.
relayed() {
  started_at=$(date +%s)
  relay
  [ $(($(date +%s) - started_at)) -ge 2 ]
}

while :; do
  lost_at=$(date +%s)
  while [ $(($(date +%s) - lost_at)) -lt "$GRACE_S" ]; do
    relayed && continue 2
    sleep 0.5
  done
  for delay in 1 2 4; do
    sleep "$delay"
    relayed && continue 2
  done
  echo "audio-worker: $2 failed after the grace and three attempts" >&2
  exit 1
done
