const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Explicit, localhost-only development proxy. This is never started by npm start.
const secret = crypto.randomBytes(32).toString('hex');
const port = Number(process.env.DEV_PORT || 3100);
const applicationPort = port + 1;
const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(applicationPort), ORENDA_EDGE_APP_PROXY_SECRET: secret }
});
const server = http.createServer((req, res) => {
  const headers = { 'content-type': req.headers['content-type'] || 'application/json',
    'x-orenda-auth-source': 'sdk-development', 'x-orenda-user-id': 'local-developer',
    'x-orenda-username': 'developer', 'x-orenda-user-name': 'Local developer',
    'x-orenda-user-roles': 'viewer', 'x-orenda-edge-proxy-secret': secret };
  const upstream = http.request({ hostname: '127.0.0.1', port: applicationPort, path: req.url, method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(503); res.end('App is starting. Refresh in a moment.'); });
  req.pipe(upstream);
});
server.listen(port, '127.0.0.1', () => console.log(`Local development: http://127.0.0.1:${port}. Box service calls require an installed app.`));
function stop() { server.close(); child.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', (code) => { server.close(); process.exitCode = code || 0; });
