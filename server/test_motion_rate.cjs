#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { randomBytes } = require('crypto');

const URL = 'ws://127.0.0.1:8080/ws';

function cid() {
  return 'perf_' + randomBytes(4).toString('hex');
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitType(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + type)), timeout);
    const fn = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === type) {
        clearTimeout(t);
        ws.off('message', fn);
        resolve(m);
      }
    };
    ws.on('message', fn);
  });
}

function collect(ws, ms) {
  return new Promise((resolve) => {
    const msgs = [];
    const fn = (raw) => msgs.push(JSON.parse(raw.toString()));
    ws.on('message', fn);
    setTimeout(() => {
      ws.off('message', fn);
      resolve(msgs);
    }, ms);
  });
}

async function main() {
  const hostId = cid();
  const guestId = cid();
  const host = await connect();
  host.send(JSON.stringify({ type: 'create', clientId: hostId }));
  const created = await waitType(host, 'created');
  const room = created.code;

  const guest = await connect();
  guest.send(JSON.stringify({ type: 'join', code: room, clientId: guestId }));
  await waitType(guest, 'joined');
  await waitType(host, 'match_ready');
  await new Promise((r) => setTimeout(r, 300));

  // layout done (fake positions)
  const layout = Array.from({ length: 6 }, (_, i) => ({ x: 100 + i * 20, y: 200 }));
  host.send(JSON.stringify({ type: 'game_action', action: { type: 'layout_done', pieces: layout } }));
  guest.send(JSON.stringify({ type: 'game_action', action: { type: 'layout_done', pieces: layout } }));
  await waitType(host, 'game_state');
  await new Promise((r) => setTimeout(r, 200));

  const guestMsgs = collect(guest, 2000);
  host.send(JSON.stringify({
    type: 'game_action',
    action: { type: 'fling', team: 'black', slot: 0, fx: 0.8, fy: 0.2 },
  }));

  const msgs = await guestMsgs;
  const states = msgs.filter((m) => m.type === 'game_state');
  const motions = msgs.filter((m) => m.type === 'game_motion');
  const motionBytes = motions.reduce((n, m) => n + JSON.stringify(m).length, 0);
  const stateBytes = states.reduce((n, m) => n + JSON.stringify(m).length, 0);

  console.log('2s window on guest:');
  console.log('  game_state:', states.length, 'total bytes:', stateBytes);
  console.log('  game_motion:', motions.length, 'total bytes:', motionBytes);
  if (motions[0]) {
    console.log('  motion sample bytes:', JSON.stringify(motions[0]).length);
  }
  if (states[0]) {
    console.log('  state sample bytes:', JSON.stringify(states[0]).length);
  }

  host.close();
  guest.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
