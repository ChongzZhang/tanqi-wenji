#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { randomBytes } = require('crypto');

const URL = 'ws://127.0.0.1:8080/ws';

function cid() {
  return 'test_' + randomBytes(6).toString('hex');
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function collect(ws, ms = 3000) {
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
  const hostMsgs = collect(host, 4000);
  host.send(JSON.stringify({ type: 'create', clientId: hostId }));
  const created = await new Promise((resolve) => {
    host.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
  if (created.type !== 'created') throw new Error('create failed');
  const ROOM = created.code;
  console.log('room', ROOM);

  const guest = await connect();
  const guestMsgs = collect(guest, 4000);
  guest.send(JSON.stringify({ type: 'join', code: ROOM, clientId: guestId }));

  await new Promise((r) => setTimeout(r, 2500));

  const hm = await hostMsgs;
  const gm = await guestMsgs;

  console.log('HOST types:', hm.map((m) => m.type));
  console.log('GUEST types:', gm.map((m) => m.type));
  const hgs = hm.filter((m) => m.type === 'game_state');
  const ggs = gm.filter((m) => m.type === 'game_state');
  console.log('HOST game_state count:', hgs.length, 'phase:', hgs[0]?.state?.phase);
  console.log('GUEST game_state count:', ggs.length, 'phase:', ggs[0]?.state?.phase);

  host.close();
  guest.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
