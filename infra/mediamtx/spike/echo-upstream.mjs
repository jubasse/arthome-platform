// R0's stand-in for the edge behind `envoy-echo.yaml`: answers with what reached it.
//   docker run -d --name r0-echo --network r0-echo -v ./echo-upstream.mjs:/echo.mjs:ro node:22-alpine node /echo.mjs

import { createServer } from 'node:http';

createServer((req, res) => {
  const seen = {
    url: req.url,
    cookie: req.headers.cookie ?? null,
    prefix: req.headers['x-r0-prefix'],
  };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
}).listen(8080, '0.0.0.0');
