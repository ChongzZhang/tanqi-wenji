'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { attachWsRoom } = require('./wsroom');

const PORT = parseInt(process.env.PORT || '8080', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const STATIC_ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.join(__dirname, '..');
const DEBUG_LOG = path.join(__dirname, '..', '..', '.cursor', 'debug-7e2651.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleDebugLog(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 65536) req.destroy();
  });
  req.on('end', () => {
    try {
      const line = body.trim();
      if (line) {
        fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
        fs.appendFileSync(DEBUG_LOG, line + '\n');
      }
      res.writeHead(204);
      res.end();
    } catch {
      res.writeHead(500);
      res.end('err');
    }
  });
  req.on('error', () => {
    res.writeHead(500);
    res.end('err');
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(STATIC_ROOT, urlPath));
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/health' || req.url.startsWith('/api/health?')) {
    sendJson(res, 200, { ok: true, gameEngine: true, version: 2 });
    return;
  }
  const pathOnly = (req.url || '').split('?')[0];
  if (pathOnly === '/api/debug-log' && req.method === 'POST') {
    handleDebugLog(req, res);
    return;
  }
  if (pathOnly === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 2048 },
});
attachWsRoom(wss);

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url === '/ws' || url.startsWith('/ws?')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  socket.destroy();
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用，无法启动联机服务。`);
    console.error('请先关闭占用该端口的程序，或结束之前的「弹棋问机-联机服务」窗口后重试。');
    console.error('查看占用: netstat -ano | findstr :8080\n');
  } else {
    console.error('服务启动失败:', err);
  }
  process.exit(1);
});

server.listen(PORT, BIND_HOST, () => {
  console.log('弹棋问机联机服务已启动');
  console.log(`  本机  http://127.0.0.1:${PORT}/`);
  if (BIND_HOST === '0.0.0.0') {
    console.log(`  局域网 http://<本机IP>:${PORT}/`);
  }
  console.log(`  WS    ws://127.0.0.1:${PORT}/ws`);
  console.log(`  静态根 ${STATIC_ROOT}`);
  console.log('按 Ctrl+C 停止。\n');
});
