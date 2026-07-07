'use strict';

/**
 * WebSocket 房间服务 — 服务端权威对局
 */

const gameEngine = require('./gameEngine');

const MAX_MEMBERS = 2;
const GRACE_MS = 90_000;
const EMPTY_ROOM_TTL = 120_000;
const EMPTY_ROOM_MATCH_TTL = 600_000;
const HEARTBEAT_MS = 30_000;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<import('ws').WebSocket, { room: Room, clientId: string }>} */
const wsIndex = new Map();

/**
 * @typedef {Object} Member
 * @property {string} clientId
 * @property {string} name
 * @property {'host'|'guest'} seat
 * @property {import('ws').WebSocket|null} ws
 * @property {boolean} online
 * @property {number} lastSeen
 */

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {Map<string, Member>} members
 * @property {string|null} hostClientId
 * @property {string|null} guestClientId
 * @property {boolean} inGame
 * @property {ReturnType<typeof setTimeout>|null} hostGraceTimer
 * @property {ReturnType<typeof setTimeout>|null} emptyTimer
 * @property {number|null} allOfflineSince
 */

function now() {
  return Date.now();
}

function send(ws, msg) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (_) {
    return false;
  }
}

function newCode() {
  for (let i = 0; i < 300; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('no room codes');
}

function memberList(room) {
  return [...room.members.values()].map(m => ({
    clientId: m.clientId,
    name: m.name,
    seat: m.seat,
    online: m.online,
  }));
}

function getPeer(room, clientId) {
  for (const m of room.members.values()) {
    if (m.clientId !== clientId) return m;
  }
  return null;
}

function seatOf(room, clientId) {
  if (room.hostClientId === clientId) return 'host';
  if (room.guestClientId === clientId) return 'guest';
  return null;
}

function clearHostGrace(room) {
  if (room.hostGraceTimer) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
}

function clearEmptyTimer(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
  room.allOfflineSince = null;
}

function emptyRoomTtlMs(room) {
  const game = gameEngine.getGame(room.code);
  if (room.inGame || (game && game.phase !== 'idle' && game.phase !== 'gameover')) {
    return EMPTY_ROOM_MATCH_TTL;
  }
  return EMPTY_ROOM_TTL;
}

function scheduleEmptyRecycle(room) {
  clearEmptyTimer(room);
  const allOffline = [...room.members.values()].every(m => !m.online);
  if (!allOffline) return;
  room.allOfflineSince = now();
  const ttl = emptyRoomTtlMs(room);
  room.emptyTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    const stillAllOffline = [...room.members.values()].every(m => !m.online);
    if (stillAllOffline) {
      destroyRoom(room.code);
    }
  }, ttl);
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearHostGrace(room);
  clearEmptyTimer(room);
  for (const m of room.members.values()) {
    if (m.ws) wsIndex.delete(m.ws);
  }
  rooms.delete(code);
}

function attachMemberWs(member, ws, room, clientId) {
  if (member.ws && member.ws !== ws && member.ws.readyState === 1) {
    try { member.ws.close(4000, 'replaced'); } catch (_) { /* ignore */ }
  }
  member.ws = ws;
  member.online = true;
  member.lastSeen = now();
  wsIndex.set(ws, { room, clientId });
}

function promoteGuestToHost(room) {
  if (!room.guestClientId) return false;
  const guest = room.members.get(room.guestClientId);
  if (!guest) return false;

  const oldHostId = room.hostClientId;
  if (oldHostId) {
    const oldHost = room.members.get(oldHostId);
    if (oldHost) {
      oldHost.seat = 'guest';
      oldHost.online = false;
      oldHost.ws = null;
    }
  }

  guest.seat = 'host';
  room.hostClientId = guest.clientId;
  room.guestClientId = oldHostId || null;
  if (oldHostId && room.members.has(oldHostId)) {
    const oh = room.members.get(oldHostId);
    if (oh) oh.seat = 'guest';
  } else {
    room.guestClientId = null;
  }

  clearHostGrace(room);

  broadcast(room, {
    type: 'host_migrated',
    code: room.code,
    hostClientId: room.hostClientId,
    members: memberList(room),
  });

  const newHost = room.members.get(room.hostClientId);
  if (newHost?.ws) {
    send(newHost.ws, {
      type: 'role_changed',
      seat: 'host',
      code: room.code,
      members: memberList(room),
    });
  }
  return true;
}

function scheduleHostGrace(room) {
  clearHostGrace(room);
  room.hostGraceTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    const host = room.hostClientId ? room.members.get(room.hostClientId) : null;
    if (host && !host.online) {
      promoteGuestToHost(room);
    }
  }, GRACE_MS);
}

function broadcastGame(room, msg) {
  const raw = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (m.ws && m.online) {
      try { m.ws.send(raw); } catch (_) { /* ignore */ }
    }
  }
}

function tryStartGame(room) {
  try {
    const game = gameEngine.tryAutoStart(room, broadcastGame);
    if (game && game.phase !== 'idle') {
      notifyMatchReady(room);
    }
  } catch (err) {
    console.error('[game] tryStartGame failed:', err);
  }
}

function pushGameStateTo(ws, roomCode, retry = 0) {
  const msg = gameEngine.getFullStateMessage(roomCode);
  if (!msg) return;
  if (!send(ws, msg) && retry < 8) {
    setTimeout(() => pushGameStateTo(ws, roomCode, retry + 1), 80);
  }
}

function notifyMatchReady(room) {
  const game = gameEngine.getGame(room.code);
  if (!game || game.phase === 'idle') return;
  const msg = { type: 'match_ready', code: room.code, phase: game.phase };
  for (const m of room.members.values()) {
    if (m.ws && m.online) send(m.ws, msg);
  }
}

function broadcast(room, msg, exceptClientId = null) {
  for (const m of room.members.values()) {
    if (exceptClientId && m.clientId === exceptClientId) continue;
    if (m.ws && m.online) send(m.ws, msg);
  }
}

function relayToPeers(room, senderClientId, payload) {
  for (const m of room.members.values()) {
    if (m.clientId === senderClientId) continue;
    if (m.ws && m.online) send(m.ws, payload);
  }
}

/** 同一 clientId 只能在一个房间；建房/加入前先清掉旧房间席位 */
function evictClientFromOtherRooms(clientId, keepCode = null) {
  for (const room of rooms.values()) {
    if (keepCode && room.code === keepCode) continue;
    const member = room.members.get(clientId);
    if (!member) continue;

    const wasHost = member.seat === 'host';
    const peer = getPeer(room, clientId);
    if (member.ws) wsIndex.delete(member.ws);

    room.members.delete(clientId);
    if (room.hostClientId === clientId) room.hostClientId = null;
    if (room.guestClientId === clientId) room.guestClientId = null;

    if (peer?.ws && peer.online) {
      send(peer.ws, { type: 'peer_left', code: room.code, clientId });
    }

    if (room.members.size === 0) {
      gameEngine.destroy(room.code);
      destroyRoom(room.code);
    } else if (wasHost && room.guestClientId) {
      promoteGuestToHost(room);
    }
  }
}

function onCreate(ws, clientId, name) {
  if (!clientId) {
    send(ws, { type: 'error', message: '缺少 clientId' });
    return;
  }
  evictClientFromOtherRooms(clientId);
  const code = newCode();
  /** @type {Room} */
  const room = {
    code,
    members: new Map(),
    hostClientId: clientId,
    guestClientId: null,
    inGame: false,
    hostGraceTimer: null,
    emptyTimer: null,
    allOfflineSince: null,
  };
  /** @type {Member} */
  const member = {
    clientId,
    name: name || '玩家',
    seat: 'host',
    ws,
    online: true,
    lastSeen: now(),
  };
  room.members.set(clientId, member);
  rooms.set(code, room);
  wsIndex.set(ws, { room, clientId });

  send(ws, {
    type: 'created',
    code,
    seat: 'host',
    clientId,
    members: memberList(room),
  });
}

function onJoin(ws, code, clientId, name) {
  code = String(code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    send(ws, { type: 'error', message: '房间号格式错误' });
    return;
  }
  if (!clientId) {
    send(ws, { type: 'error', message: '缺少 clientId' });
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'no_room', message: '房间不存在' });
    return;
  }

  evictClientFromOtherRooms(clientId, code);

  const existing = room.members.get(clientId);
  if (existing) {
    return onHello(ws, code, clientId);
  }

  if (room.guestClientId && room.guestClientId !== clientId) {
    const guest = room.members.get(room.guestClientId);
    if (guest && guest.online) {
      send(ws, { type: 'error', message: '房间已满' });
      return;
    }
  }

  const onlineCount = [...room.members.values()].filter(m => m.online).length;
  if (onlineCount >= MAX_MEMBERS && !existing) {
    send(ws, { type: 'error', message: '房间已满' });
    return;
  }

  /** @type {Member} */
  const member = existing || {
    clientId,
    name: name || '玩家',
    seat: 'guest',
    ws: null,
    online: false,
    lastSeen: now(),
  };
  member.name = name || member.name;
  member.seat = 'guest';
  member.online = true;
  member.lastSeen = now();
  room.guestClientId = clientId;
  room.members.set(clientId, member);
  attachMemberWs(member, ws, room, clientId);
  clearEmptyTimer(room);

  send(ws, {
    type: 'joined',
    code,
    seat: 'guest',
    role: 'guest',
    clientId,
    members: memberList(room),
  });

  const host = room.hostClientId ? room.members.get(room.hostClientId) : null;
  if (host?.ws && host.online) {
    send(host.ws, { type: 'peer_joined', code, clientId, members: memberList(room) });
  }
  tryStartGame(room);
  pushGameStateTo(ws, code);
  if (host?.ws && host.online) pushGameStateTo(host.ws, code);
}

function onHello(ws, code, clientId) {
  code = String(code || '').trim();
  if (!clientId) {
    send(ws, { type: 'error', message: '缺少 clientId' });
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'no_room', message: '房间不存在或已回收' });
    return;
  }

  const member = room.members.get(clientId);
  if (!member) {
    send(ws, { type: 'error', message: '未找到您的席位，请重新加入' });
    return;
  }

  attachMemberWs(member, ws, room, clientId);
  member.online = true;
  member.lastSeen = now();
  clearEmptyTimer(room);

  if (member.seat === 'host') {
    clearHostGrace(room);
    const guest = getPeer(room, clientId);
    if (guest?.ws && guest.online) {
      send(guest.ws, { type: 'host_online', code });
    }
  }

  const peer = getPeer(room, clientId);
  if (peer?.ws && peer.online) {
    send(peer.ws, { type: 'peer_joined', code, clientId, resumed: true, members: memberList(room) });
  }

  send(ws, {
    type: 'resumed',
    code,
    seat: member.seat,
    role: member.seat,
    clientId,
    members: memberList(room),
    peerOnline: !!(peer && peer.online),
  });

  if (member.seat === 'host' && peer) {
    send(ws, { type: 'peer_joined', code, clientId: peer.clientId, members: memberList(room) });
  }

  gameEngine.syncPeerPresence(room);
  pushGameStateTo(ws, code);
  if (peer?.ws && peer.online) {
    pushGameStateTo(peer.ws, code);
  }
  if (peer?.online) {
    tryStartGame(room);
  }
}

function onLeave(ws) {
  const info = wsIndex.get(ws);
  if (!info) return;
  const { room, clientId } = info;
  const member = room.members.get(clientId);
  if (!member) return;

  const wasHost = member.seat === 'host';
  const peer = getPeer(room, clientId);

  room.members.delete(clientId);
  if (room.hostClientId === clientId) room.hostClientId = null;
  if (room.guestClientId === clientId) room.guestClientId = null;
  wsIndex.delete(ws);

  if (peer?.ws && peer.online) {
    send(peer.ws, { type: 'peer_left', code: room.code, clientId });
  }

  if (room.members.size === 0) {
    gameEngine.destroy(room.code);
    destroyRoom(room.code);
    return;
  }

  if (wasHost && room.guestClientId) {
    promoteGuestToHost(room);
  }

  send(ws, { type: 'left', code: room.code });
}

function onQuit(ws) {
  const info = wsIndex.get(ws);
  if (!info) return;
  const { room, clientId } = info;
  const member = room.members.get(clientId);
  if (!member) return;

  member.online = false;
  member.ws = null;
  member.lastSeen = now();
  wsIndex.delete(ws);

  const peer = getPeer(room, clientId);
  if (peer?.ws && peer.online) {
    send(peer.ws, { type: 'peer_left', code: room.code, clientId, temporary: true });
  }

  if (room.inGame) {
    gameEngine.onPeerAway(room);
  }

  if (member.seat === 'host' && room.inGame) {
    if (peer?.ws && peer.online) {
      send(peer.ws, { type: 'host_offline', code: room.code, graceMs: GRACE_MS });
    }
    scheduleHostGrace(room);
  }

  scheduleEmptyRecycle(room);
  send(ws, { type: 'quit_ok', code: room.code });
}

function onRelay(ws, payload) {
  const info = wsIndex.get(ws);
  if (!info) {
    send(ws, { type: 'error', message: '未加入房间' });
    return;
  }
  const { room, clientId } = info;
  const member = room.members.get(clientId);
  if (!member || !member.online) return;

  if (payload?.type === 'board_setup') {
    const peer = getPeer(room, clientId);
    if (!peer || !peer.online) {
      send(ws, { type: 'error', message: '对方尚未加入，无法开始' });
      return;
    }
    room.inGame = true;
  }

  relayToPeers(room, clientId, payload);
}

function onDisconnect(ws) {
  const info = wsIndex.get(ws);
  if (!info) return;
  const { room, clientId } = info;
  const member = room.members.get(clientId);
  if (!member) {
    wsIndex.delete(ws);
    return;
  }

  member.online = false;
  member.ws = null;
  member.lastSeen = now();
  wsIndex.delete(ws);

  const peer = getPeer(room, clientId);
  if (peer?.ws && peer.online) {
    send(peer.ws, {
      type: 'peer_left',
      code: room.code,
      clientId,
      temporary: true,
    });
  }

  if (room.inGame) {
    gameEngine.onPeerAway(room);
  }

  if (member.seat === 'host') {
    if (room.inGame && peer?.ws && peer.online) {
      send(peer.ws, { type: 'host_offline', code: room.code, graceMs: GRACE_MS });
    }
    if (room.inGame) {
      scheduleHostGrace(room);
    }
  }

  scheduleEmptyRecycle(room);
}

function handleMessage(ws, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', message: '无效 JSON' });
    return;
  }

  const type = data.type;

  if (type === 'ping') {
    send(ws, { type: 'pong', t: data.t || now() });
    const info = wsIndex.get(ws);
    if (info) {
      const m = info.room.members.get(info.clientId);
      if (m) m.lastSeen = now();
    }
    return;
  }

  if (type === 'create') {
    onCreate(ws, data.clientId, data.name);
    return;
  }
  if (type === 'join') {
    onJoin(ws, data.code, data.clientId, data.name);
    return;
  }
  if (type === 'hello') {
    onHello(ws, data.code, data.clientId);
    return;
  }
  if (type === 'leave') {
    onLeave(ws);
    return;
  }
  if (type === 'quit') {
    onQuit(ws);
    return;
  }
  if (type === 'relay') {
    onRelay(ws, data.payload || {});
    return;
  }
  if (type === 'game_action') {
    const info = wsIndex.get(ws);
    if (!info) {
      send(ws, { type: 'error', message: '未加入房间' });
      return;
    }
    gameEngine.handleAction(info.room, info.clientId, data.action || {}, broadcastGame);
    const actionType = (data.action || {}).type;
    if (actionType === 'request_start') {
      pushGameStateTo(ws, info.room.code);
    }
    return;
  }

  if (wsIndex.has(ws)) {
    onRelay(ws, data);
  } else {
    send(ws, { type: 'error', message: '未加入房间' });
  }
}

function attachWsRoom(wss) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      handleMessage(ws, raw.toString());
    });

    ws.on('close', () => onDisconnect(ws));
    ws.on('error', () => onDisconnect(ws));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        try { ws.terminate(); } catch (_) { /* ignore */ }
        return;
      }
      ws.isAlive = false;
      send(ws, { type: 'ping', t: now() });
      try { ws.ping(); } catch (_) { /* ignore */ }
    });
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));
}

module.exports = { attachWsRoom, rooms, GRACE_MS, EMPTY_ROOM_TTL };
