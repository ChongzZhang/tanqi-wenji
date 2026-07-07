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

function onceJson(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => {
      try { resolve(JSON.parse(raw.toString())); }
      catch (e) { reject(e); }
    });
    ws.once('error', reject);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function testFlow() {
  const hostId = cid();
  const guestId = cid();

  const host = await connect();
  send(host, { type: 'create', clientId: hostId });
  const created = await onceJson(host);
  if (created.type !== 'created') throw new Error('create failed: ' + JSON.stringify(created));
  const ROOM = created.code;
  console.log(`[OK] host created room ${ROOM}`);

  const guest = await connect();
  send(guest, { type: 'join', code: ROOM, clientId: guestId });
  const joined = await onceJson(guest);
  if (joined.type !== 'joined') throw new Error('join failed: ' + JSON.stringify(joined));
  console.log('[OK] guest joined');

  const peer = await onceJson(host);
  if (peer.type !== 'peer_joined') throw new Error('peer_joined missing: ' + JSON.stringify(peer));
  console.log('[OK] host received peer_joined');

  send(host, { type: 'relay', payload: { type: 'board_setup', board: { obstacles: [] } } });
  const board = await onceJson(guest);
  if (board.type !== 'board_setup') throw new Error('relay failed: ' + JSON.stringify(board));
  console.log('[OK] board_setup relayed to guest');

  host.close();
  guest.close();

  const host2 = await connect();
  const host2Id = cid();
  send(host2, { type: 'create', clientId: host2Id });
  await onceJson(host2);
  send(host2, { type: 'relay', payload: { type: 'board_setup', board: {} } });
  const err = await onceJson(host2);
  if (err.type !== 'error') throw new Error('expected error: ' + JSON.stringify(err));
  console.log(`[OK] blocked start without guest: ${err.message}`);
  host2.close();

  const resumeId = cid();
  const host3 = await connect();
  send(host3, { type: 'create', clientId: resumeId });
  const code3 = (await onceJson(host3)).code;
  host3.close();
  await new Promise(r => setTimeout(r, 100));

  const host3b = await connect();
  send(host3b, { type: 'hello', code: code3, clientId: resumeId });
  const resumed = await onceJson(host3b);
  if (resumed.type !== 'resumed') throw new Error('resume failed: ' + JSON.stringify(resumed));
  console.log('[OK] hello resume works');
  host3b.close();

  console.log('\nAll online flow checks passed.');
}

testFlow().catch((e) => {
  console.error(e);
  process.exit(1);
});
