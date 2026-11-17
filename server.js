/**
 * ColdChain Sync - Full-Stack Local Server & Camunda 8 Live Integration
 * Bridges the Stitch UI frontend with the live Camunda 8 Zeebe REST API.
 * Zero external dependencies (uses Node.js native http, fs, path).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const MOCKS_DIR = path.join(__dirname, 'Backend', 'docs', 'mocks');
const BPMN_DIR = path.join(__dirname, 'Backend', 'bpmn-models');

// ─── Camunda 8 Connection Config ─────────────────────────────────────────────
const CAMUNDA_BASE = process.env.CAMUNDA_BASE_URL || 'http://localhost:8080';
const CAMUNDA_USER = process.env.CAMUNDA_USER || 'demo';
const CAMUNDA_PASS = process.env.CAMUNDA_PASS || 'demo';
const CAMUNDA_AUTH = 'Basic ' + Buffer.from(`${CAMUNDA_USER}:${CAMUNDA_PASS}`).toString('base64');

/**
 * Proxy a request to the Camunda REST API and pipe the response back.
 */
function camundaProxy(res, method, camundaPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CAMUNDA_BASE + camundaPath);
    const opts = {
      hostname: url.hostname,
      port: url.port || 8080,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': CAMUNDA_AUTH,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    const req = http.request(opts, (camRes) => {
      let data = '';
      camRes.on('data', d => data += d);
      camRes.on('end', () => {
        res.writeHead(camRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
        resolve();
      });
    });
    req.on('error', (e) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Camunda unavailable', detail: e.message, camunda: CAMUNDA_BASE }));
      resolve();
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Deploy BPMN/Form files to Camunda via multipart/form-data.
 */
function deployToCamunda(res, files) {
  return new Promise((resolve) => {
    const boundary = '----ColdChainBoundary' + Date.now();
    let body = Buffer.alloc(0);
    files.forEach(({ filename, content, mimeType }) => {
      const header = `--${boundary}\r\nContent-Disposition: form-data; name="resources"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
      body = Buffer.concat([body, Buffer.from(header), content, Buffer.from('\r\n')]);
    });
    body = Buffer.concat([body, Buffer.from(`--${boundary}--\r\n`)]);

    const url = new URL(CAMUNDA_BASE + '/v2/deployments');
    const opts = {
      hostname: url.hostname,
      port: url.port || 8080,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': CAMUNDA_AUTH,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Accept': 'application/json'
      }
    };
    const req = http.request(opts, (camRes) => {
      let data = '';
      camRes.on('data', d => data += d);
      camRes.on('end', () => {
        res.writeHead(camRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
        resolve();
      });
    });
    req.on('error', (e) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Deploy failed', detail: e.message }));
      resolve();
    });
    req.write(body);
    req.end();
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── Collect request body ───────────────────────────────────────────────────
  function withBody(cb) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => cb(body));
  }

  // ══════════════════════════════════════════════════════════════════
  //  CAMUNDA LIVE PROXY ROUTES  (prefix: /camunda/*)
  // ══════════════════════════════════════════════════════════════════

  if (pathname.startsWith('/camunda/')) {
    const camPath = pathname.replace('/camunda', '');
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
      withBody(body => camundaProxy(res, req.method, camPath, body));
    } else {
      camundaProxy(res, req.method, camPath + url.search);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  BPMN DEPLOY ENDPOINT  POST /api/deploy
  // ══════════════════════════════════════════════════════════════════
  if (pathname === '/api/deploy' && req.method === 'POST') {
    const filesToDeploy = [];
    const formFiles = [
      { name: 'review-replenishment-request.form', mime: 'application/json' },
      { name: 'qa-inspection.form', mime: 'application/json' },
      { name: 'qa-decision.form', mime: 'application/json' },
      { name: 'confirm-goods-receipt.form', mime: 'application/json' },
      { name: 'ap-clerk-manual-review.form', mime: 'application/json' }
    ];
    // Deploy forms first, then BPMN files
    formFiles.forEach(f => {
      const fp = path.join(BPMN_DIR, 'forms', f.name);
      if (fs.existsSync(fp)) filesToDeploy.push({ filename: f.name, content: fs.readFileSync(fp), mimeType: f.mime });
    });
    ['supplier-invoice-three-way-match.bpmn', 'cold-chain-replenishment-main.bpmn'].forEach(bn => {
      const fp = path.join(BPMN_DIR, bn);
      if (fs.existsSync(fp)) filesToDeploy.push({ filename: bn, content: fs.readFileSync(fp), mimeType: 'application/xml' });
    });
    if (filesToDeploy.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No BPMN/Form files found to deploy' }));
      return;
    }
    deployToCamunda(res, filesToDeploy);
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CAMUNDA STATUS  GET /api/camunda-status
  // ══════════════════════════════════════════════════════════════════
  if (pathname === '/api/camunda-status') {
    camundaProxy(res, 'GET', '/v2/topology');
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  LIVE PROCESS INSTANCES  GET /api/instances
  // ══════════════════════════════════════════════════════════════════
  if (pathname === '/api/instances') {
    camundaProxy(res, 'POST', '/v2/process-instances/search',
      JSON.stringify({ filter: { processDefinitionId: 'coldChainReplenishment', state: 'ACTIVE' }, page: { limit: 20 } }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  LIVE USER TASKS  GET /api/tasks
  // ══════════════════════════════════════════════════════════════════
  if (pathname === '/api/tasks') {
    camundaProxy(res, 'POST', '/v2/user-tasks/search',
      JSON.stringify({ filter: { state: 'CREATED' }, page: { limit: 20 } }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  COMPLETE USER TASK  POST /api/tasks/:taskKey/complete
  // ══════════════════════════════════════════════════════════════════
  if (pathname.match(/^\/api\/tasks\/(\d+)\/complete$/) && req.method === 'POST') {
    const taskKey = pathname.split('/')[3];
    withBody(body => camundaProxy(res, 'POST', `/v2/user-tasks/${taskKey}/completion`, body));
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  START PROCESS  POST /api/v1/process/start
  // ══════════════════════════════════════════════════════════════════
  if (pathname === '/api/v1/process/start' && req.method === 'POST') {
    withBody(body => {
      let vars = {};
      try { vars = JSON.parse(body); } catch (_) {}
      if (!vars || Object.keys(vars).length === 0) {
        const startPayloadPath = path.join(__dirname, 'Backend', 'docs', 'start-payload.json');
        if (fs.existsSync(startPayloadPath)) {
          vars = JSON.parse(fs.readFileSync(startPayloadPath, 'utf-8'));
          vars.requestId = 'REQ-' + Math.floor(1000 + Math.random() * 9000);
        }
      }
      camundaProxy(res, 'POST', '/v2/process-instances', JSON.stringify({
        processDefinitionId: 'coldChainReplenishment',
        variables: vars.variables || vars
      }));
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  //  EXISTING MOCK API ROUTES  (fallback for IoT / Supplier mocks)
  // ══════════════════════════════════════════════════════════════════
  if (pathname.startsWith('/api/')) {
    // GET /api/health
    if (pathname === '/api/health') {
      // Check real Camunda status and augment response
      const camUrl = new URL(CAMUNDA_BASE + '/v2/topology');
      const opts = { hostname: camUrl.hostname, port: camUrl.port || 8080, path: camUrl.pathname, method: 'GET', headers: { 'Authorization': CAMUNDA_AUTH } };
      const camReq = http.request(opts, (camRes) => {
        let data = '';
        camRes.on('data', d => data += d);
        camRes.on('end', () => {
          let camStatus = 'DISCONNECTED';
          try { const t = JSON.parse(data); if (t.brokers) camStatus = 'CONNECTED'; } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'HEALTHY', engine: 'Camunda 8 Zeebe v8.5+', camunda: camStatus, timestamp: new Date().toISOString() }));
        });
      });
      camReq.on('error', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'HEALTHY', engine: 'Camunda 8 Zeebe v8.5+', camunda: 'DISCONNECTED', timestamp: new Date().toISOString() }));
      });
      camReq.end();
      return;
    }

    // GET /api/v1/telemetry/excursions or /api/v1/telemetry/:po
    if (pathname.includes('/excursions')) {
      const mockFile = path.join(MOCKS_DIR, 'iot-telemetry-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      const excursion = data.endpoints.find(e => e.scenario.includes('Excursion Alarm'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(excursion ? excursion.responseBody : {}));
      return;
    }

    if (pathname.startsWith('/api/v1/telemetry')) {
      const mockFile = path.join(MOCKS_DIR, 'iot-telemetry-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      const normal = data.endpoints.find(e => e.scenario.includes('Normal'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(normal ? normal.responseBody : {}));
      return;
    }

    // POST /api/v1/supplier/po
    if (pathname === '/api/v1/supplier/po' && req.method === 'POST') {
      const mockFile = path.join(MOCKS_DIR, 'supplier-api-mock.json');
      const data = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.endpoints[0].responseBody));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
    return;
  }

  // Static File Serving
  let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(FRONTEND_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ColdChain Sync Server listening at http://localhost:${PORT}`);
  });
}

module.exports = server;
