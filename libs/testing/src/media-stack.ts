/**
 * The media plane of `compose.media.yaml` in containers: the MediaMTX origin and edge, and Envoy in
 * front of the edge, on their own network, with the configurations the project runs. The images
 * are read out of `compose.media.yaml`, as `startStack` reads `compose.yaml`.
 */

import { fileURLToPath } from 'node:url';

import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

import { MEDIA_COMPOSE_FILE, composeImage } from './stack.js';

const INFRA = new URL('../../../infra/', import.meta.url);
const ORIGIN_ALIAS = 'mediamtx-origin';
const EDGE_ALIAS = 'mediamtx-edge';
const STARTUP_MS = 120_000;

export interface MediaStackRequest {
  /**
   * The origin's `MTX_AUTHHTTPADDRESS` as the origin reaches it: MX1's route or a suite's stand-in,
   *   the secret in the userinfo. `host.docker.internal` is the host.
   */
  readonly authorizeUrl: string;
}

export type EncoderProtocol = 'whip' | 'srt';

export interface EncoderRequest {
  readonly protocol: EncoderProtocol;
  readonly streamPath: string;
  readonly key: string;
  /** Opus by default over WHIP, AAC over SRT. */
  readonly audio?: 'opus' | 'aac';
}

export interface StartedEncoder {
  stop(): Promise<void>;
}

export interface StartedMediaStack {
  /** `STREAMING_MEDIA_PROVIDER=mediamtx` and every `MEDIAMTX_*` URL, on the mapped ports. */
  readonly providerEnv: Readonly<Record<string, string>>;
  readonly playbackEdgeUrl: string;
  readonly edgeHlsPortMapped: boolean;
  startEncoder(request: EncoderRequest): Promise<StartedEncoder>;
  stop(): Promise<void>;
}

function infraFile(path: string): string {
  return fileURLToPath(new URL(path, INFRA));
}

function urlOf(container: StartedTestContainer, port: number, scheme = 'http'): string {
  return `${scheme}://${container.getHost()}:${String(container.getMappedPort(port))}`;
}

function apiReady(): ReturnType<typeof Wait.forHttp> {
  return Wait.forHttp('/v3/paths/list', 9997).forStatusCode(200);
}

function encoderConfiguration({ streamPath, key, audio = 'opus' }: EncoderRequest): string {
  return [
    'logLevel: info',
    'rtsp: true',
    'rtspTransports: [tcp]',
    'rtmp: false',
    'hls: false',
    'webrtc: false',
    'srt: false',
    'moq: false',
    'paths:',
    '  src:',
    `    runOnInit: /encoder.sh rtsp://127.0.0.1:8554/src ${audio}`,
    '    runOnInitRestart: true',
    '    forward:',
    `      - dest: whip://${ORIGIN_ALIAS}:8889/live/${streamPath}/whip`,
    `        whipBearerToken: ${key}`,
    '',
  ].join('\n');
}

async function startEncoder(
  network: StartedNetwork,
  image: string,
  request: EncoderRequest,
): Promise<StartedTestContainer> {
  const encoder = new GenericContainer(image)
    .withNetwork(network)
    .withCopyFilesToContainer([
      { source: infraFile('mediamtx/test-encoder.sh'), target: '/encoder.sh', mode: 0o755 },
    ]);
  const started =
    request.protocol === 'whip'
      ? await encoder
          .withCopyContentToContainer([
            { content: encoderConfiguration(request), target: '/mediamtx.yml' },
          ])
          .start()
      : await encoder
          .withEntrypoint(['sh', '-c'])
          .withCommand([
            'while :; do /encoder.sh "$0" "$1" mpegts; sleep 5; done',
            `srt://${ORIGIN_ALIAS}:8890?streamid=publish:live/${request.streamPath}:encoder:${request.key}&pkt_size=1316`,
            request.audio ?? 'aac',
          ])
          .start();
  return started;
}

export async function startMediaStack(request: MediaStackRequest): Promise<StartedMediaStack> {
  const originImage = composeImage(ORIGIN_ALIAS, MEDIA_COMPOSE_FILE);
  const edgeImage = composeImage(EDGE_ALIAS, MEDIA_COMPOSE_FILE);
  const network = await new Network().start();
  const started: StartedTestContainer[] = [];
  try {
    const origin = await new GenericContainer(originImage)
      .withNetwork(network)
      .withNetworkAliases(ORIGIN_ALIAS)
      .withEnvironment({ MTX_AUTHHTTPADDRESS: request.authorizeUrl })
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withCopyFilesToContainer([
        { source: infraFile('mediamtx/origin.yml'), target: '/mediamtx.yml' },
      ])
      .withExposedPorts(8888, 8889, 9996, 9997, 9998)
      .withWaitStrategy(apiReady())
      .withStartupTimeout(STARTUP_MS)
      .start();
    started.push(origin);

    const edge = await new GenericContainer(edgeImage)
      .withNetwork(network)
      .withNetworkAliases(EDGE_ALIAS)
      .withCopyFilesToContainer([
        { source: infraFile('mediamtx/edge.yml'), target: '/mediamtx.yml' },
        { source: infraFile('mediamtx/audio-worker.sh'), target: '/audio-worker.sh', mode: 0o755 },
      ])
      .withExposedPorts(9997)
      .withWaitStrategy(apiReady())
      .withStartupTimeout(STARTUP_MS)
      .start();
    started.push(edge);

    const envoy = await new GenericContainer(composeImage('playback-edge', MEDIA_COMPOSE_FILE))
      .withNetwork(network)
      .withCopyFilesToContainer([
        { source: infraFile('envoy/edge.yaml'), target: '/etc/envoy/edge.yaml' },
        {
          source: infraFile('mediamtx/playback-jwks.json'),
          target: '/etc/envoy/playback-jwks.json',
        },
      ])
      .withCommand(['-c', '/etc/envoy/edge.yaml', '--log-level', 'warn'])
      .withExposedPorts(8080)
      // Distroless: no shell for a port check. Outside `/watch/` it answers 404 once listening.
      .withWaitStrategy(Wait.forHttp('/', 8080).forStatusCode(404))
      .withStartupTimeout(STARTUP_MS)
      .start();
    started.push(envoy);

    const playbackEdgeUrl = urlOf(envoy, 8080);
    return {
      providerEnv: {
        STREAMING_MEDIA_PROVIDER: 'mediamtx',
        MEDIAMTX_ORIGIN_API_URL: urlOf(origin, 9997),
        MEDIAMTX_ORIGIN_METRICS_URL: urlOf(origin, 9998),
        MEDIAMTX_ORIGIN_PLAYBACK_URL: urlOf(origin, 9996),
        MEDIAMTX_ORIGIN_RTSP_URL: `rtsp://${ORIGIN_ALIAS}:8554`,
        MEDIAMTX_EDGE_API_URL: urlOf(edge, 9997),
        MEDIAMTX_WEBRTC_URL: urlOf(origin, 8889),
        // SRT is UDP and stays on the media network: encoders publish from it.
        MEDIAMTX_SRT_URL: `srt://${ORIGIN_ALIAS}:8890`,
        MEDIAMTX_MONITOR_HLS_URL: urlOf(origin, 8888),
        MEDIAMTX_PLAYBACK_EDGE_URL: playbackEdgeUrl,
      },
      playbackEdgeUrl,
      edgeHlsPortMapped: hasMappedPort(edge, 8888),
      startEncoder: async (encoder) => {
        const container = await startEncoder(network, edgeImage, encoder);
        started.push(container);
        return {
          stop: async (): Promise<void> => {
            started.splice(started.indexOf(container), 1);
            await container.stop({ timeout: 1_000 });
          },
        };
      },
      stop: async (): Promise<void> => {
        for (const container of started.reverse()) await container.stop({ timeout: 1_000 });
        await network.stop();
      },
    };
  } catch (error) {
    for (const container of started.reverse()) await container.stop();
    await network.stop();
    throw error;
  }
}

function hasMappedPort(container: StartedTestContainer, port: number): boolean {
  try {
    container.getMappedPort(port);
    return true;
  } catch {
    return false;
  }
}
