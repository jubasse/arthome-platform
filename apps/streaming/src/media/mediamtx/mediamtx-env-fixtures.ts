/** `compose.media.yaml`'s host ports, as the specs configure the provider. */
export const MEDIAMTX_SPEC_ENV: Readonly<Record<string, string>> = {
  STREAMING_MEDIA_PROVIDER: 'mediamtx',
  MEDIAMTX_ORIGIN_API_URL: 'http://127.0.0.1:59997',
  MEDIAMTX_ORIGIN_METRICS_URL: 'http://127.0.0.1:59998',
  MEDIAMTX_ORIGIN_PLAYBACK_URL: 'http://127.0.0.1:59996',
  MEDIAMTX_ORIGIN_RTSP_URL: 'rtsp://mediamtx-origin:8554',
  MEDIAMTX_EDGE_API_URL: 'http://127.0.0.1:59995',
  MEDIAMTX_WEBRTC_URL: 'http://127.0.0.1:58889',
  MEDIAMTX_SRT_URL: 'srt://127.0.0.1:58890',
  MEDIAMTX_MONITOR_HLS_URL: 'http://127.0.0.1:58887',
  MEDIAMTX_PLAYBACK_EDGE_URL: 'http://localhost:58888',
};
