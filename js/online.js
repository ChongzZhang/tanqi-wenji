/**
 * 联机客户端 — 对齐 MULTIPLAYER_GUIDE 架构
 * WebSocket /ws · clientId 持久化 · 指数退避重连 · 心跳保活
 */
const Online = (() => {
  const LS_CLIENT_ID = 'tanqiNetClientId';
  const LS_SESSION = 'tanqiNetSession';

  const RECONNECT_MIN = 500;
  const RECONNECT_MAX = 8000;
  const RECONNECT_FACTOR = 1.7;
  const CLIENT_PING_MS = 25_000;

  let ws = null;
  let role = null;
  let roomCode = '';
  let peerJoined = false;
  let clientId = '';
  let playerName = '玩家';
  let reconnectDelay = RECONNECT_MIN;
  let reconnectTimer = null;
  let pingTimer = null;
  let intentionalClose = false;
  let pendingCreate = false;
  let pendingJoinCode = null;
  let sessionKept = false;
  const listeners = {};

  let matchPhase = null;

  function on(type, fn) { listeners[type] = fn; }
  function off(type) { delete listeners[type]; }

  function emit(type, data) {
    if (listeners[type]) listeners[type](data);
  }

  function getOrCreateClientId() {
    try {
      let id = localStorage.getItem(LS_CLIENT_ID);
      if (!id) {
        id = 'tq_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(LS_CLIENT_ID, id);
      }
      return id;
    } catch {
      return 'tq_ephemeral_' + Date.now();
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(LS_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSession() {
    if (!roomCode || !role) return;
    try {
      const prev = loadSession();
      localStorage.setItem(LS_SESSION, JSON.stringify({
        code: roomCode,
        seat: role,
        name: playerName,
        inMatch: prev?.inMatch || false,
      }));
    } catch { /* ignore */ }
  }

  function updateSessionMeta(patch) {
    try {
      const sess = loadSession() || {};
      if (roomCode) sess.code = roomCode;
      if (role) sess.seat = role;
      sess.name = playerName;
      Object.assign(sess, patch || {});
      if (sess.code) localStorage.setItem(LS_SESSION, JSON.stringify(sess));
    } catch { /* ignore */ }
  }

  function markInMatch(v) {
    updateSessionMeta({ inMatch: !!v });
  }

  function isInMatch() {
    return !!loadSession()?.inMatch;
  }

  function clearSession() {
    try { localStorage.removeItem(LS_SESSION); } catch { /* ignore */ }
  }

  function wsUrl() {
    const host = location.host;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${host}/ws`;
  }

  function isLocalDev() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

  function isPublicAccess() {
    return location.protocol === 'https:' || (!isLocalDev() && location.hostname !== '');
  }

  function connectionErrorHint() {
    if (isPublicAccess()) {
      return '无法连接联机服务器。请确认：① 使用房主分享的完整链接（非 localhost）② 房主已开启公网房间（serve-public.bat）';
    }
    return '无法连接联机服务器。房主请先运行 start-all.bat；好友请让房主分享公网链接，不要打开 localhost。';
  }

  function resetLobbyState() {
    role = null;
    roomCode = '';
    peerJoined = false;
    pendingCreate = false;
    pendingJoinCode = null;
  }

  function resetSession() {
    resetLobbyState();
    clearSession();
    sessionKept = false;
  }

  function applyRoomState(data) {
    if (data.code) roomCode = data.code;
    if (data.seat) role = data.seat;
    else if (data.role) role = data.role;
    if (data.members) {
      const others = data.members.filter(m => m.clientId !== clientId && m.online);
      peerJoined = others.length > 0;
    }
    if (typeof data.peerOnline === 'boolean') {
      peerJoined = data.peerOnline;
    }
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      sendDirect({ type: 'ping', t: Date.now() });
    }, CLIENT_PING_MS);
  }

  function scheduleReconnect() {
    if (intentionalClose || reconnectTimer) return;
    const sess = loadSession();
    if (!sess && !pendingCreate && !pendingJoinCode) return;
    if (!sess?.code && !pendingCreate && !pendingJoinCode) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      emit('reconnecting', { delay: reconnectDelay });
      connect().catch(() => scheduleReconnect());
    }, reconnectDelay);
    reconnectDelay = Math.min(Math.round(reconnectDelay * RECONNECT_FACTOR), RECONNECT_MAX);
  }

  function flushPendingLobbyAction() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    clientId = clientId || getOrCreateClientId();
    if (pendingCreate) {
      sendDirect({ type: 'create', clientId, name: playerName });
    } else if (pendingJoinCode) {
      sendDirect({ type: 'join', code: pendingJoinCode, clientId, name: playerName });
    } else {
      const sess = loadSession();
      if (sess?.code) {
        sendDirect({ type: 'hello', code: sess.code, clientId });
        if (sess.seat) role = sess.seat;
        roomCode = sess.code;
      }
    }
  }

  async function abandonMatchForNewRoom() {
    clearReconnect();
    intentionalClose = true;
    markInMatch(false);
    const hadRoom = roomCode || loadSession()?.code;
    if (ws && ws.readyState === WebSocket.OPEN && hadRoom) {
      sendDirect({ type: 'leave' });
      await new Promise((r) => setTimeout(r, 150));
    }
    stopPing();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    resetLobbyState();
    clearSession();
    sessionKept = false;
    intentionalClose = false;
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = RECONNECT_MIN;
  }

  function handleServerMessage(data) {
    const t = data.type;

    if (t === 'pong') return;

    if (t === 'created') {
      applyRoomState(data);
      saveSession();
      pendingCreate = false;
    }
    if (t === 'joined' || t === 'resumed') {
      applyRoomState(data);
      saveSession();
      pendingJoinCode = null;
      if (t === 'resumed') emit('resumed', data);
    }
    if (t === 'peer_joined') {
      peerJoined = true;
    }
    if (t === 'peer_left') {
      if (!data.temporary) peerJoined = false;
    }
    if (t === 'host_offline') {
      emit('host_offline', data);
    }
    if (t === 'host_online') {
      emit('host_online', data);
    }
    if (t === 'host_migrated' || t === 'role_changed') {
      if (data.seat) role = data.seat;
      else if (data.hostClientId === clientId) role = 'host';
      saveSession();
      emit('host_migrated', data);
    }
    if (t === 'no_room') {
      resetLobbyState();
      clearSession();
      emit('no_room', data);
    }
    if (t === 'left' || t === 'quit_ok') {
      resetLobbyState();
    }

    if (t === 'match_ready') {
      matchPhase = data.phase || null;
      emit('match_ready', data);
      if (typeof Game !== 'undefined' && Game.onMatchReady) {
        Game.onMatchReady(data);
      }
    }

    if (t === 'game_motion') {
      if (typeof Game !== 'undefined' && Game.onServerGameMotion) {
        Game.onServerGameMotion(data);
      }
    }

    if (t === 'game_state') {
      if (data?.state?.phase) matchPhase = data.state.phase;
      emit('game_state', data);
      if (typeof Game !== 'undefined' && Game.onServerGameState) {
        Game.onServerGameState(data);
      }
    }

    emit(t, data);

    if (t !== 'game_state' && t !== 'game_motion' && typeof Game !== 'undefined' && Game.onOnlineMessage) {
      Game.onOnlineMessage(data);
    }
  }

  function requestGameStart() {
    return sendGameAction({ type: 'request_start' });
  }

  function sendGameAction(action) {
    return sendDirect({ type: 'game_action', action });
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        flushPendingLobbyAction();
        resolve();
        return;
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        const onOpen = () => { cleanup(); resolve(); };
        const onFail = () => { cleanup(); reject(new Error(connectionErrorHint())); };
        const cleanup = () => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onFail);
          ws.removeEventListener('close', onFail);
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onFail);
        ws.addEventListener('close', onFail);
        return;
      }

      intentionalClose = false;
      clientId = getOrCreateClientId();

      const socket = new WebSocket(wsUrl());
      ws = socket;

      socket.onopen = () => {
        clearReconnect();
        reconnectDelay = RECONNECT_MIN;
        startPing();
        flushPendingLobbyAction();
        resolve();
      };

      socket.onerror = () => {
        reject(new Error(connectionErrorHint()));
      };

      socket.onclose = () => {
        stopPing();
        ws = null;
        if (!intentionalClose) {
          emit('disconnected', {});
          scheduleReconnect();
        }
      };

      socket.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        handleServerMessage(data);
      };
    });
  }

  function sendDirect(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  function relay(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (role !== 'host' && role !== 'guest') return false;
    ws.send(JSON.stringify({ type: 'relay', payload }));
    return true;
  }

  function leave() {
    intentionalClose = true;
    clearReconnect();
    sendDirect({ type: 'leave' });
    stopPing();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    resetSession();
  }

  function quitGame() {
    intentionalClose = true;
    clearReconnect();
    sendDirect({ type: 'quit' });
    stopPing();
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
    resetLobbyState();
    sessionKept = true;
  }

  async function createRoom(name) {
    if (name) playerName = name;
    await abandonMatchForNewRoom();
    pendingCreate = true;
    intentionalClose = false;
    clientId = getOrCreateClientId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('created');
        off('error');
        pendingCreate = false;
        if (ws) {
          intentionalClose = true;
          try { ws.close(); } catch { /* ignore */ }
          ws = null;
          intentionalClose = false;
        }
        reject(new Error('创建房间超时，请检查网络后重试'));
      }, 20000);
      const onCreated = (data) => {
        clearTimeout(timer);
        off('created');
        off('error');
        resolve(data.code);
      };
      const onErr = (data) => {
        clearTimeout(timer);
        off('created');
        off('error');
        pendingCreate = false;
        reject(new Error(data.message || '创建失败'));
      };
      on('created', onCreated);
      on('error', onErr);
      connect().catch((e) => {
        clearTimeout(timer);
        off('created');
        off('error');
        pendingCreate = false;
        reject(e);
      });
    });
  }

  async function joinRoom(code, name) {
    if (name) playerName = name;
    const trimmed = String(code).trim();
    if (!/^\d{6}$/.test(trimmed)) {
      throw new Error('请输入 6 位数字房间号');
    }
    await abandonMatchForNewRoom();
    pendingJoinCode = trimmed;
    intentionalClose = false;
    clientId = getOrCreateClientId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('joined');
        off('resumed');
        off('error');
        off('no_room');
        pendingJoinCode = null;
        reject(new Error('加入房间超时，请检查网络后重试'));
      }, 20000);
      const onSuccess = (data) => {
        if (data.type === 'joined' || data.type === 'resumed') {
          clearTimeout(timer);
          off('joined');
          off('resumed');
          off('error');
          off('no_room');
          resolve(data.code);
        }
      };
      const onErr = (data) => {
        clearTimeout(timer);
        off('joined');
        off('resumed');
        off('error');
        off('no_room');
        pendingJoinCode = null;
        reject(new Error(data.message || '加入失败'));
      };
      const onNoRoom = (data) => {
        clearTimeout(timer);
        off('joined');
        off('resumed');
        off('error');
        off('no_room');
        pendingJoinCode = null;
        reject(new Error(data.message || '房间不存在'));
      };
      on('joined', onSuccess);
      on('resumed', onSuccess);
      on('error', onErr);
      on('no_room', onNoRoom);
      connect().catch((e) => {
        clearTimeout(timer);
        off('joined');
        off('resumed');
        off('error');
        off('no_room');
        pendingJoinCode = null;
        reject(e);
      });
    });
  }

  async function tryResume() {
    const sess = loadSession();
    if (!sess?.code) return false;
    clientId = getOrCreateClientId();
    role = sess.seat || null;
    roomCode = sess.code;
    intentionalClose = false;
    try {
      await connect();
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000);
        const done = (ok) => {
          clearTimeout(timer);
          off('resumed');
          off('no_room');
          off('error');
          resolve(ok);
        };
        on('resumed', (data) => {
          applyRoomState(data);
          peerJoined = !!data.peerOnline;
          sendDirect({ type: 'game_action', action: { type: 'request_start' } });
          done(true);
        });
        on('no_room', () => done(false));
        on('error', () => done(false));
      });
    } catch {
      return false;
    }
  }

  function setPlayerName(name) {
    if (name) playerName = name;
  }

  function getRole() { return role; }
  function getRoomCode() { return roomCode; }
  function getClientId() { return clientId || getOrCreateClientId(); }
  function hasPeer() { return peerJoined; }
  function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }
  function hasStoredSession() { return !!loadSession(); }

  function buildInviteUrl(code) {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  function getMatchPhase() { return matchPhase; }

  return {
    on,
    off,
    createRoom,
    joinRoom,
    tryResume,
    leave,
    quitGame,
    relay,
    sendGameAction,
    requestGameStart,
    getMatchPhase,
    getRole,
    getRoomCode,
    getClientId,
    hasPeer,
    isConnected,
    hasStoredSession,
    wsUrl,
    resetSession,
    markInMatch,
    isInMatch,
    abandonMatchForNewRoom,
    updateSessionMeta,
    setPlayerName,
    isLocalDev,
    isPublicAccess,
    buildInviteUrl,
  };
})();
