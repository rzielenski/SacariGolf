#!/usr/bin/env node
/**
 * Mock launch monitor — a fake bridge for testing Range Sesh Live.
 *
 * Speaks the same thing a real bridge does: a WebSocket server emitting
 * GSPro Connect v1 shot JSON. Point Sacari at your network and it will
 * discover this and start receiving shots, which proves the whole pipeline
 * (discovery → connect → parse → ball-flight physics → render → save)
 * without any hardware attached.
 *
 *   node tools/mock-launch-monitor.js            # a shot every 6s on port 921
 *   node tools/mock-launch-monitor.js --port 8888
 *   node tools/mock-launch-monitor.js --every 3
 *   node tools/mock-launch-monitor.js --club driver
 *
 * Zero dependencies — the WebSocket handshake and text framing are done by
 * hand below, because pulling a package in for a throwaway test tool isn't
 * worth it.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(arg('port', 921));
const EVERY_S = Number(arg('every', 6));
const FIXED_CLUB = arg('club', null);

// ── shot generator (PGA-ish, with scatter) ───────────────────────────────────
const CLUBS = {
  driver: { b: 152, l: 12.5, s: 2700 },
  '3w': { b: 145, l: 10.5, s: 3500 },
  '5i': { b: 124, l: 14.0, s: 5400 },
  '7i': { b: 113, l: 17.5, s: 7100 },
  '9i': { b: 102, l: 22.0, s: 8600 },
  pw: { b: 96, l: 25.0, s: 9300 },
};
const jitter = (x) => (Math.random() - 0.5) * 2 * x;

function makeShot(n) {
  const names = Object.keys(CLUBS);
  const club = FIXED_CLUB && CLUBS[FIXED_CLUB] ? FIXED_CLUB : names[n % names.length];
  const c = CLUBS[club];
  const ballSpeed = +(c.b + jitter(c.b * 0.04)).toFixed(1);
  const spin = Math.round(c.s + jitter(c.s * 0.12));
  const spinAxis = +jitter(9).toFixed(1);
  return {
    club,
    payload: {
      DeviceID: 'SacariMockLM',
      Units: 'Yards',
      ShotNumber: n,
      APIversion: '1',
      BallData: {
        Speed: ballSpeed,
        SpinAxis: spinAxis,
        TotalSpin: spin,
        BackSpin: Math.round(spin * Math.cos((spinAxis * Math.PI) / 180)),
        SideSpin: Math.round(spin * Math.sin((spinAxis * Math.PI) / 180)),
        HLA: +jitter(3).toFixed(1),
        VLA: +(c.l + jitter(1.8)).toFixed(1),
      },
      ClubData: {
        Speed: +(ballSpeed / 1.45).toFixed(1),
        SmashFactor: 1.45,
      },
      ShotDataOptions: {
        ContainsBallData: true,
        ContainsClubData: true,
        LaunchMonitorIsReady: true,
      },
    },
  };
}

// ── minimal WebSocket server framing ─────────────────────────────────────────
/** Encode a server→client TEXT frame. Server frames must NOT be masked. */
function encodeText(str) {
  const body = Buffer.from(str, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

const clients = new Set();

const server = http.createServer((req, res) => {
  // A plain GET is handy for "is it up?" checks from a browser.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Sacari mock launch monitor. Connect over WebSocket.\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  clients.add(socket);
  console.log(`[+] client connected from ${req.socket.remoteAddress}  (${clients.size} total)`);

  socket.on('close', () => { clients.delete(socket); console.log(`[-] client left (${clients.size} left)`); });
  socket.on('error', () => { clients.delete(socket); });
  // We don't need to parse anything the client sends; drain it.
  socket.on('data', () => { });
});

let n = 0;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('');
  console.log('  Sacari mock launch monitor');
  console.log('  ─────────────────────────────────────────────');
  addrs.forEach((a) => console.log(`   ws://${a}:${PORT}`));
  console.log(`   sending a shot every ${EVERY_S}s${FIXED_CLUB ? ` (club: ${FIXED_CLUB})` : ''}`);
  console.log('   open Range Live on your phone — it should find this automatically');
  console.log('   Ctrl+C to stop');
  console.log('');

  setInterval(() => {
    if (!clients.size) return;
    n += 1;
    const { club, payload } = makeShot(n);
    const frame = encodeText(JSON.stringify(payload));
    for (const c of clients) { try { c.write(frame); } catch { /* dropped */ } }
    console.log(
      `  → shot ${n}: ${club.padEnd(7)} ball ${payload.BallData.Speed} mph, ` +
      `launch ${payload.BallData.VLA}°, spin ${payload.BallData.TotalSpin}, axis ${payload.BallData.SpinAxis}°`,
    );
  }, Math.max(1, EVERY_S) * 1000);
});
