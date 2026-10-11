// A stand-in for MX1's route (`POST /v1/media-server/authorize`, MX1 §6 S1 to S5), for the R0 spike
// only: Basic auth on the shared secret, `publish` on `live/<streamPath>` over webrtc or srt with
// the run's key (`token`, else `password`), everything else refused. Logs no credential.
//
//   node stub-authorizer.mjs <port> <secret> <streamPath>=<key>...

import { createServer } from 'node:http';

const [port, secret, ...pairs] = process.argv.slice(2);
const keys = new Map(pairs.map((pair) => pair.split('=')));
const PROTOCOLS = new Map([
  ['webrtc', 'whip'],
  ['srt', 'srt'],
]);

function decide(request) {
  if (request.action !== 'publish') return 403;
  const protocol = PROTOCOLS.get(request.protocol);
  if (protocol === undefined || !request.path.startsWith('live/')) return 403;
  const streamPath = request.path.slice('live/'.length);
  const presented = request.token || request.password;
  if (!presented || keys.get(streamPath) !== presented) return 403;
  return 204;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const basic = (req.headers.authorization ?? '').replace(/^Basic /, '');
    const password = Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':');
    let status = 401;
    let body = {};
    if (password === secret) {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      status = decide(body);
    }
    const fields = Object.keys(body).sort().join(',');
    const credential = body.token ? 'token' : body.password ? 'password' : 'none';
    process.stdout.write(
      `authorize ${status} action=${body.action} protocol=${body.protocol} credential=${credential} fields=${fields}\n`,
    );
    res.writeHead(status).end();
  });
}).listen(Number(port), '0.0.0.0');
