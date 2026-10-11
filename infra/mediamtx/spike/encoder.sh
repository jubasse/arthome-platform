#!/bin/sh
# A test encoder for the spike and the drill: H.264 baseline 720p30, keyframe every 2 s, Opus (or
# AAC with `aac`), and the wall clock burned into the top-left strip as 24 bits of epoch
# milliseconds (one 40-pixel box per bit, white for 1), read back at the player.
#
#   encoder.sh <output URL> [opus|aac] [ffmpeg output format] [output options...]

out="$1"
audio="${2:-opus}"
format="${3:-rtsp}"
shift $(($# < 3 ? $# : 3))

bits=""
i=0
while [ "$i" -lt 24 ]; do
  bits="$bits,drawbox=x=$((i * 40)):y=0:w=40:h=40:color=white:t=fill:enable='eq(mod(floor(t*1000/$((1 << i))),2),1)'"
  i=$((i + 1))
done

if [ "$audio" = aac ]; then
  audio_codec="-c:a aac -b:a 128k"
else
  audio_codec="-c:a libopus -b:a 64k"
fi

transport=""
[ "$format" = rtsp ] && transport="-rtsp_transport tcp"

# shellcheck disable=SC2086
exec ffmpeg -hide_banner -loglevel warning -nostdin \
  -re -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -re -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -filter_complex "[0:v]settb=1/1000,setpts=RTCTIME/1000,drawbox=x=0:y=0:w=960:h=40:color=black:t=fill$bits,settb=1/30,setpts=N[v]" \
  -map "[v]" -map 1:a -ac 2 -ar 48000 \
  -c:v libx264 -profile:v baseline -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 -b:v 2500k -maxrate 2500k -bufsize 1000k \
  $audio_codec \
  $transport "$@" -f "$format" "$out"
