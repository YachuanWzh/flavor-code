// Superharness brainstorm mind-map server. Zero-dependency Node.
// Serves mindmap.html, watches content/mindmap.json and pushes snapshots to the
// browser over WebSocket; records browser interactions to state/events (JSONL).
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- config ----------
const SESSION_DIR = process.env.SUPERHARNESS_SESSION_DIR;
if (!SESSION_DIR) {
  console.error('SUPERHARNESS_SESSION_DIR is required');
  process.exit(1);
}
const CONTENT_DIR = path.join(SESSION_DIR, 'content');
const STATE_DIR = path.join(SESSION_DIR, 'state');
const SNAPSHOT_FILE = path.join(CONTENT_DIR, 'mindmap.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events');
const EDITS_FILE = path.join(STATE_DIR, 'edits');
const INFO_FILE = path.join(STATE_DIR, 'server-info');
const STOPPED_FILE = path.join(STATE_DIR, 'server-stopped');
const PORT = Number(process.env.SUPERHARNESS_PORT) || (49152 + Math.floor(Math.random() * 16383));
const HOST = process.env.SUPERHARNESS_HOST || '127.0.0.1';
const IDLE_TIMEOUT_MS = Number(process.env.SUPERHARNESS_IDLE_TIMEOUT_MS) || 30 * 60 * 1000;
const IDLE_CHECK_MS = Math.min(5000, IDLE_TIMEOUT_MS);

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };

// ---------- websocket protocol (RFC 6455) ----------
const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (!masked) throw new Error('Client frames must be masked');
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;
  const mask = buffer.slice(offset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  return { opcode, payload: data, bytesConsumed: totalLen };
}

const clients = new Set();
function broadcast(text) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(text));
  for (const socket of clients) socket.write(frame);
}

// ---------- snapshot ----------
const DEFAULT_SNAPSHOT = JSON.stringify({
  type: 'mindmap:snapshot', rev: 0, topic: '', status: 'exploring', root: null,
});

function currentSnapshot() {
  try { return fs.readFileSync(SNAPSHOT_FILE, 'utf-8'); }
  catch { return DEFAULT_SNAPSHOT; }
}

// ---------- http ----------
function serveFile(res, name, type) {
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(path.join(__dirname, name)));
}

const server = http.createServer((req, res) => {
  touch();
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    serveFile(res, 'mindmap.html', 'text/html; charset=utf-8');
  } else if (req.method === 'GET' && req.url === '/layout.js') {
    serveFile(res, 'layout.js', 'application/javascript; charset=utf-8');
  } else if (req.method === 'GET' && req.url === '/mindmap.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(currentSnapshot());
  } else if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        const file = (msg.type === 'node:edit' || msg.type === 'submit') ? EDITS_FILE : EVENTS_FILE;
        fs.appendFileSync(file, body.trim() + '\n');
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400);
        res.end('invalid JSON');
      }
    });
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---------- websocket upgrade ----------
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + computeAcceptKey(key) + '\r\n\r\n');
  clients.add(socket);
  touch();
  socket.write(encodeFrame(OPCODES.TEXT, Buffer.from(currentSnapshot())));
  let buf = Buffer.alloc(0);
  socket.on('data', data => {
    touch();
    buf = Buffer.concat([buf, data]);
    while (true) {
      let frame;
      try { frame = decodeFrame(buf); } catch { socket.destroy(); return; }
      if (!frame) break;
      buf = buf.slice(frame.bytesConsumed);
      if (frame.opcode === OPCODES.CLOSE) { socket.end(); return; }
      if (frame.opcode === OPCODES.PING) socket.write(encodeFrame(OPCODES.PONG, frame.payload));
    }
  });
  const drop = () => clients.delete(socket);
  socket.on('close', drop);
  socket.on('error', drop);
});

// ---------- snapshot file watch ----------
let lastMtime = 0;
try { lastMtime = fs.statSync(SNAPSHOT_FILE).mtimeMs; } catch {}
setInterval(() => {
  let stat;
  try { stat = fs.statSync(SNAPSHOT_FILE); } catch { return; }
  if (stat.mtimeMs === lastMtime) return;
  lastMtime = stat.mtimeMs;
  touch();
  try { fs.writeFileSync(EVENTS_FILE, ''); } catch {}
  broadcast(currentSnapshot());
}, 500).unref();

// ---------- lifecycle ----------
function shutdown(code) {
  try { fs.writeFileSync(STOPPED_FILE, ''); } catch {}
  try { fs.unlinkSync(INFO_FILE); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown(0);
}, IDLE_CHECK_MS).unref();

server.listen(PORT, HOST, () => {
  try { fs.unlinkSync(STOPPED_FILE); } catch {}
  const urlHost = HOST === '127.0.0.1' ? 'localhost' : HOST;
  const info = {
    type: 'server-started',
    port: PORT,
    url: 'http://' + urlHost + ':' + PORT,
    pid: process.pid,
    content_dir: CONTENT_DIR,
    state_dir: STATE_DIR,
  };
  fs.writeFileSync(INFO_FILE, JSON.stringify(info));
  console.log(JSON.stringify(info));
});
