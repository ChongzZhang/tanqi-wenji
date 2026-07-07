// 《幽寂弹棋》主游戏控制器

const Game = (() => {
  /** 联机行棋：在两帧服务端快照之间插值（仅显示，逻辑仍以服务端为准） */
  const MOTION_INTERP_DELAY_MS = 30;
  const MOTION_EXTRAP_MAX_MS = 55;
  let _motionDebugLast = 0;
  let _lastDebugRenderT = null;

  function debugMotionLog(location, message, data, hypothesisId) {
    const now = performance.now();
    if (now - _motionDebugLast < 400) return;
    _motionDebugLast = now;
    const payload = JSON.stringify({
      sessionId: '7e2651', location, message, data, hypothesisId,
      timestamp: Date.now(), runId: 'client',
    });
    // #region agent log
    fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {});
    fetch('http://127.0.0.1:7537/ingest/4836427c-de48-42f7-9a10-e0dafee36f74', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7e2651' }, body: payload }).catch(() => {});
    // #endregion
  }

  function updateServerClockOffset(serverT) {
    if (typeof serverT !== 'number') return;
    const sample = serverT - Date.now();
    const prev = state._serverClockOffset;
    state._serverClockOffset = prev == null ? sample : prev * 0.85 + sample * 0.15;
  }

  function getServerNow() {
    return Date.now() + (state._serverClockOffset || 0);
  }

  function getAdaptiveRenderDelay() {
    const buf = state._motionBuffer;
    if (!buf.length) return MOTION_INTERP_DELAY_MS;
    const lagMs = getServerNow() - buf[buf.length - 1].t;
    const base = (buf.length >= 2 && lagMs < 25) ? 22 : MOTION_INTERP_DELAY_MS;
    if (buf.length < 2) return base;
    if (lagMs <= 0) return base;
    return Math.min(80, base + lagMs * 0.25);
  }

  /** 将服务端权威棋子快照写入显示缓冲（不改变规则，仅显示） */
  function ingestServerMotionPieces(pieces, seq, serverT, source) {
    if (!pieces || !pieces.length || !Array.isArray(pieces[0])) return;
    state._motionPieceState = pieces.map((r) => r.slice());
    pushMotionSnapshot(pieces, seq, serverT, false);
    Physics.applyPieceMotionCompact(state._motionPieceState, { snap: true, merge: true });
    debugMotionLog('game.js:ingestServerMotionPieces', source || 'seed', {
      seq, pieceCount: pieces.length, bufLen: state._motionBuffer.length,
    }, 'H8');
  }

  function applyDisplayExtrapolation(renderT, buf) {
    if (!buf.length) return 0;
    const latest = buf[buf.length - 1];
    const lagMs = getServerNow() - latest.t;
    if (lagMs > 120) return 0;
    const aheadMs = Math.min(MOTION_EXTRAP_MAX_MS, Math.max(0, getServerNow() - renderT));
    if (aheadMs < 2) return 0;
    Physics.extrapolateWithDamping(aheadMs / 1000);
    return aheadMs;
  }

  function getServerRenderTime() {
    return getServerNow() - getAdaptiveRenderDelay();
  }

  function seedMotionPieceStateFromPhysics() {
    state._motionPieceState = Physics.getPieces().map((p) => {
      let sp = 0;
      if (p.special === 'curve') sp = 1;
      else if (p.special === 'speed') sp = 2;
      return [
        p.gameTeam === 'black' ? 0 : 1,
        p.slot,
        Math.round(p.position.x * 10) / 10,
        Math.round(p.position.y * 10) / 10,
        Math.round(p.velocity.x * 100) / 100,
        Math.round(p.velocity.y * 100) / 100,
        sp,
      ];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  // ===== 游戏状态 =====
  const state = {
    phase: 'menu',        // menu | layout | playing | gameover | replay
    subPhase: 'waiting',  // (playing下) waiting | moving | combo
    mode: '2P',
    matchMode: '2P',      // 2P | 4FFA
    gameType: 'classic',  // classic | fun
    aiLevel: 2,
    aiTeam: 'white',
    humanTeam: 'white',
    aiTeams: ['black', 'red', 'blue'],
    eliminated: null,     // Set<teamId>，四方乱战用

    onlineRole: null,       // host | guest
    onlineMyTeam: null,     // black | white
    onlineBlindLayout: false,
    onlineLayouts: { black: null, white: null },
    onlineWaitingOpponent: false,
    onlineLayoutStarted: false,
    onlineBoardSnapshot: null,

    currentTurn: 'black',
    blackScore: 0,
    whiteScore: 0,
    winScore: 6,
    winner: null,

    layoutTeam: 'black',
    layoutPlaced: 0,
    layoutConfirmed: { black: false, white: false },

    timer: 30,
    timerMax: 30,
    timerActive: false,
    timerPaused: false,
    peerAway: false,
    _timerInterval: null,

    stats: {
      black: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
      white: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
    },

    boardSkin: 'lacquer',
    pieceSkin: 'jade',

    selectedPiece: null,
    isDragging: false,
    dragWorldPos: null,
    movingPiece: null,
    hitThisTurn: false,
    scoredThisTurn: false,   // 本回合是否将对方棋子打下盘（连击判定依据）

    // 连击提示计时
    _comboTimer: 0,
    _comboInterval: null,
    _comboBtnRects: null,
    _confirmBtnRect: null,
    _gameoverBtns: null,
    _killStatsExpanded: false,
    _killStatsToggleRect: null,

    replayData: [],
    dt: 0.016,
    lastTime: 0,
    _motionTargets: null,
    _lastMotionSync: 0,
    _stateSeq: 0,
    _lastMotionSeq: 0,
    _motionBuffer: [],
    _motionPieceState: null,
    _serverClockOffset: null,
    _visibleScreen: 'main-menu',
  };

  let canvas;

  // ===== 初始化 =====
  function init(c) {
    canvas = c;
    resizeCanvas();           // 必须先设置 canvas 尺寸
    Physics.init();
    Renderer.init(c);         // 此时 canvas 已是正确尺寸
    Input.init(c);
    Audio.init();
    window.addEventListener('resize', onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }

    Physics.onCollision((pos, vel, bodyA, bodyB) => {
      if (state.mode === 'ONLINE') return;
      const intensity = Math.min(vel / 15, 1);
      Renderer.addCollisionParticles(pos.x, pos.y, intensity);
      Audio.pieceHit(intensity, state.pieceSkin);

      if (bodyA.gameTeam && bodyB.gameTeam && bodyA.gameTeam !== bodyB.gameTeam) {
        if (state.phase === 'playing' && state.subPhase === 'moving') {
          state.hitThisTurn = true;
          state.stats[state.currentTurn].hits++;
        }
      }
    });

    Physics.onWallHit((pos, vel, kind) => {
      if (state.mode === 'ONLINE') return;
      const intensity = Math.min(vel / 15, 1);
      Renderer.addCollisionParticles(pos.x, pos.y, intensity * 0.7);
      Audio.pieceHit(intensity * 0.6, state.pieceSkin);
    });

    Physics.onOutOfBounds(body => {
      if (state.mode === 'ONLINE') return;
      handlePieceFall(body);
    });

    Input.onFling = (piece, fx, fy, strength) => {
      if (state.phase === 'playing' && state.subPhase === 'waiting') {
        if (piece.gameTeam !== state.currentTurn) return;
        if (state.mode === 'ONLINE' && piece.gameTeam !== state.onlineMyTeam) return;
        if (state.mode === 'ONLINE') {
          state.movingPiece = piece;
          Renderer.setCameraFollow(piece.position.x, piece.position.y, true);
          Online.sendGameAction({
            type: 'fling',
            team: piece.gameTeam,
            slot: piece.slot,
            fx, fy,
          });
          state.selectedPiece = null;
          state.isDragging = false;
          Input.reset();
          return;
        }
        doFling(piece, fx, fy, strength);
      }
    };

    Input.onPieceSelect = piece => {
      if (state.phase === 'playing' && state.subPhase === 'waiting') {
        if (state.mode === 'ONLINE' && state.currentTurn !== state.onlineMyTeam) return;
        state.selectedPiece = piece;
      }
    };
  }

  function onResize() {
    resizeCanvas();
    Renderer.updateBaseTransform();
  }

  function resizeCanvas() {
    const cap = state.mode === 'ONLINE' ? 2.0 : 2.5;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    canvas._dpr = dpr;
    const w = Math.round(window.visualViewport?.width || window.innerWidth);
    const h = Math.round(window.visualViewport?.height || window.innerHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  function viewW() {
    return canvas.clientWidth || window.innerWidth;
  }

  function viewH() {
    return canvas.clientHeight || window.innerHeight;
  }

  function isFourWay() {
    return state.matchMode === '4FFA';
  }

  function syncGameplayCamera(immediate = false) {
    if (isFourWay()) Renderer.setCameraForFFA(immediate);
    else Renderer.setCameraOverview();
  }

  function getAiLevel() {
    if (isFourWay()) return Teams.MASTER_AI_LEVEL;
    return state.aiLevel;
  }

  function isAiTeam(team) {
    if (isFourWay()) return state.aiTeams.includes(team);
    return state.mode === '1P' && team === state.aiTeam;
  }

  function isHumanTurn() {
    if (isFourWay()) return state.currentTurn === state.humanTeam;
    if (state.mode === 'ONLINE') return state.currentTurn === state.onlineMyTeam;
    return !(state.mode === '1P' && state.currentTurn === state.aiTeam);
  }

  function teamHasPieces(team) {
    return Physics.getPieces().some(p => p.gameTeam === team);
  }

  function teamHasGeneral(team) {
    return Physics.getPieces().some(p => p.gameTeam === team && p.isGeneral);
  }

  function isMobileView() {
    const w = viewW();
    const h = viewH();
    return w < 520 || h < 520;
  }

  function clearMotionBuffer() {
    state._motionBuffer = [];
  }

  function mergeMotionDelta(partial) {
    if (!partial || !partial.length) return state._motionPieceState || [];
    if (!state._motionPieceState || !state._motionPieceState.length) {
      seedMotionPieceStateFromPhysics();
    }
    const map = {};
    for (const row of state._motionPieceState) {
      map[`${row[0]}:${row[1]}`] = row;
    }
    for (const row of partial) {
      map[`${row[0]}:${row[1]}`] = row;
    }
    state._motionPieceState = Object.values(map).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return state._motionPieceState;
  }

  function snapshotMotionRows(rows) {
    return rows.map((r) => r.slice());
  }

  function pushMotionSnapshot(pieces, seq, serverT, partial) {
    if (!pieces || !pieces.length) return;
    const t = typeof serverT === 'number' ? serverT : Date.now();
    updateServerClockOffset(t);
    const buf = state._motionBuffer;
    if (buf.length && buf[buf.length - 1].seq === seq) return;
    const merged = partial
      ? mergeMotionDelta(pieces)
      : (state._motionPieceState = snapshotMotionRows(pieces));
    buf.push({ t, seq, pieces: snapshotMotionRows(merged) });
    if (buf.length > 64) buf.shift();
  }

  function lerpCompactRows(rowsA, rowsB, alpha) {
    const mapB = {};
    for (let i = 0; i < rowsB.length; i++) {
      const row = rowsB[i];
      mapB[`${row[0]}:${row[1]}`] = row;
    }
    const mapA = {};
    const out = [];
    for (let i = 0; i < rowsA.length; i++) {
      const row = rowsA[i];
      const key = `${row[0]}:${row[1]}`;
      mapA[key] = true;
      const b = mapB[key];
      if (!b || alpha <= 0) {
        out.push(row);
        continue;
      }
      if (alpha >= 1) {
        out.push(b);
        continue;
      }
      const lerped = [
        row[0], row[1],
        row[2] + (b[2] - row[2]) * alpha,
        row[3] + (b[3] - row[3]) * alpha,
        row[4] + (b[4] - row[4]) * alpha,
        row[5] + (b[5] - row[5]) * alpha,
      ];
      if (row.length > 6 || b.length > 6) {
        lerped.push(alpha >= 0.5 ? (b[6] || 0) : (row[6] || 0));
      }
      out.push(lerped);
    }
    for (let i = 0; i < rowsB.length; i++) {
      const row = rowsB[i];
      const key = `${row[0]}:${row[1]}`;
      if (!mapA[key]) out.push(row);
    }
    return out;
  }

  /** 严格基于服务端快照插值，不算本地碰撞 */
  function applyOnlineMotionDisplay() {
    const buf = state._motionBuffer;
    if (!buf.length) return;
    const latest = buf[buf.length - 1];
    const adaptiveDelay = getAdaptiveRenderDelay();
    const lagMs = getServerNow() - latest.t;
    const renderT = getServerRenderTime();
    const renderTDelta = _lastDebugRenderT == null ? 0 : renderT - _lastDebugRenderT;
    _lastDebugRenderT = renderT;
    const physCount = Physics.getPieces().length;
    let mode = 'hold';
    let alpha = 0;

    if (renderT <= buf[0].t) {
      Physics.applyPieceMotionCompact(buf[0].pieces, { snap: true, merge: true });
      const extrapMs = applyDisplayExtrapolation(renderT, buf);
      debugMotionLog('game.js:applyOnlineMotionDisplay', extrapMs ? 'hold+extrap' : 'hold early buffer', {
        bufLen: buf.length, renderT, renderTDelta, latestT: latest.t, clockOffset: state._serverClockOffset,
        delayMs: adaptiveDelay, lagMs, extrapMs, mergedPieces: buf[0].pieces.length, physCount, mode,
      }, 'H2');
      return;
    }

    let i = 0;
    while (i + 1 < buf.length && buf[i + 1].t <= renderT) i++;
    const a = buf[i];
    const b = buf[Math.min(i + 1, buf.length - 1)];

    if (b === a || b.t <= a.t) {
      mode = 'snap';
      Physics.applyPieceMotionCompact(b.pieces, { snap: true, merge: true });
    } else {
      mode = 'lerp';
      alpha = Math.max(0, Math.min(1, (renderT - a.t) / (b.t - a.t)));
      Physics.applyPieceMotionCompact(lerpCompactRows(a.pieces, b.pieces, alpha), { snap: true, merge: true });
    }
    const extrapMs = applyDisplayExtrapolation(renderT, buf);
    debugMotionLog('game.js:applyOnlineMotionDisplay', extrapMs ? `${mode}+extrap` : mode, {
      bufLen: buf.length, renderT, renderTDelta, latestT: latest.t, clockOffset: state._serverClockOffset,
      delayMs: adaptiveDelay, lagMs, extrapMs, displayLagMs: getServerNow() - renderT,
      mergedPieces: b.pieces.length, physCount, mode, alpha,
    }, mode === 'lerp' ? 'H3' : 'H2');
  }

  function syncOnlinePhysicsMode() {
    /* 联机：物理只在服务端计算，客户端硬同步服务端快照 */
  }

  function applyServerFx(events) {
    if (!events || !events.length) return;
    let played = 0;
    for (const ev of events) {
      if (played >= 3) break;
      if (!Array.isArray(ev) || ev.length < 4) continue;
      const intensity = ev[3];
      if (intensity < 0.08) continue;
      Renderer.addCollisionParticles(ev[1], ev[2], intensity, true);
      Audio.pieceHit(intensity, state.pieceSkin);
      played++;
    }
  }

  function syncMovingPieceRef(movingPieceKey) {
    if (movingPieceKey && state.subPhase === 'moving') {
      const [team, slotStr] = String(movingPieceKey).split(':');
      const slot = parseInt(slotStr, 10);
      state.movingPiece = Physics.getPieces().find(
        (p) => p.gameTeam === team && p.slot === slot
      ) || null;
    } else {
      state.movingPiece = null;
    }
  }

  function applyServerMotion(motion, seq, serverT) {
    if (!motion || !motion.pieces) return;
    if (state.mode !== 'ONLINE') return;
    if (seq != null) {
      if (seq <= (state._lastMotionSeq || 0)) return;
      state._lastMotionSeq = seq;
    }
    if (motion.subPhase) state.subPhase = motion.subPhase;
    pushMotionSnapshot(motion.pieces, seq, serverT, !!motion.partial);
    const before = Physics.getPieces().length;
    applyOnlineMotionDisplay();
    // #region agent log
    if (motion.partial) {
      const payload = JSON.stringify({
        sessionId: '7e2651', location: 'game.js:applyServerMotion', message: 'partial motion',
        data: {
          partial: true, pktPieces: motion.pieces.length,
          statePieces: (state._motionPieceState || []).length,
          physBefore: before, physAfter: Physics.getPieces().length, seq,
        },
        hypothesisId: 'H1', timestamp: Date.now(), runId: 'client',
      });
      fetch('/api/debug-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {});
      fetch('http://127.0.0.1:7537/ingest/4836427c-de48-42f7-9a10-e0dafee36f74', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7e2651' }, body: payload }).catch(() => {});
    }
    // #endregion
    syncMovingPieceRef(motion.movingPiece);
    applyServerFx(motion.fx);
  }

  function tryPlaceOnlinePiece(wx, wy) {
    if (state.layoutPlaced >= 6) return;
    const R = Physics.W.pieceRadius;
    const tooClose = Physics.getPieces().some(p =>
      Math.hypot(p.position.x - wx, p.position.y - wy) < R * 2.5
    );
    if (tooClose) return;
    const onHole = Physics.getHoles().some(h =>
      Math.hypot(h.x - wx, h.y - wy) < h.r + R
    );
    const onBlock = Physics.getBlocks().some(b =>
      Math.hypot(b.position.x - wx, b.position.y - wy) < (b.blockSize || 26) * 0.7 + R
    );
    if (onHole || onBlock) return;
    Physics.createPiece(wx, wy, state.onlineMyTeam, state.layoutPlaced);
    state.layoutPlaced++;
    Audio.uiClick();
  }

  function enableOnlinePlacementInput() {
    if (!state.onlineMyTeam) return;
    Input.enablePlacement(state.onlineMyTeam, tryPlaceOnlinePiece);
  }

  /** 棋盘已加载后确保联机布子输入可用（防止 game_state 重置棋盘后房主无法摆子） */
  function ensureOnlineLayoutPlacement() {
    if (state.mode !== 'ONLINE' || state.phase !== 'layout' || !state.onlineMyTeam) return;
    if (!state.onlineBoardSnapshot && !state._serverBoardKey) return;

    state.layoutTeam = state.onlineMyTeam;
    state.layoutPlaced = Physics.getPieces().filter(p => p.gameTeam === state.onlineMyTeam).length;
    state.onlineBlindLayout = true;
    state._confirmBtnRect = null;
    Renderer.setCameraForTurn(state.onlineMyTeam, true);

    if (state.layoutConfirmed[state.onlineMyTeam]) {
      Input.disablePlacement();
      state.onlineWaitingOpponent = !state.layoutConfirmed.black || !state.layoutConfirmed.white;
    } else {
      state.onlineWaitingOpponent = false;
      enableOnlinePlacementInput();
    }
  }

  function enterOnlineLayoutFromServer() {
    state.mode = 'ONLINE';
    state.onlineRole = Online.getRole();
    state.onlineMyTeam = state.onlineRole === 'host' ? 'black' : 'white';
    state.onlineLayoutStarted = true;
    state.onlineBlindLayout = true;
    state.onlineWaitingOpponent = false;
    if (state._visibleScreen !== 'game-screen') {
      showScreen('game-screen');
    }
    ensureOnlineLayoutPlacement();
    Online.markInMatch(true);
    updateOnlineGameControls();
    if (!state._ambientStarted) {
      Audio.startAmbient();
      state._ambientStarted = true;
    }
    Audio.scrollOpen();
  }

  function syncOnlineTimerFromServer() {
    clearInterval(state._timerInterval);
    state._timerInterval = null;
    state.timerActive = state.phase === 'playing' &&
      state.subPhase === 'waiting' &&
      !state.timerPaused &&
      state.currentTurn === state.onlineMyTeam;
  }

  function handleServerGameOver(winner) {
    if (state.phase === 'gameover') return;
    state.winner = winner;
    state.phase = 'gameover';
    state.subPhase = 'waiting';
    state.movingPiece = null;
    Online.markInMatch(false);
    clearLocalMatch();
    const isWinnerHuman = winner === state.onlineMyTeam;
    const poems = DATA.endingPoems[isWinnerHuman ? 'win' : 'lose'];
    state._endingPoem = poems[Math.floor(Math.random() * poems.length)];
    Audio.victory();
  }

  function decodePieceSpecial(code) {
    if (code === 1) return 'curve';
    if (code === 2) return 'speed';
    return null;
  }

  function normalizePieces(pieces) {
    if (!pieces || !pieces.length) return pieces;
    if (!Array.isArray(pieces[0])) return pieces;
    return pieces.map((row) => ({
      team: row[0] === 0 ? 'black' : 'white',
      slot: row[1],
      x: row[2],
      y: row[3],
      vx: row[4],
      vy: row[5],
      special: row.length > 6 ? decodePieceSpecial(row[6]) : null,
    }));
  }

  function applyServerState(s, serverT) {
    if (!s) return;
    const prevPhase = state.phase;
    const prevSubPhase = state.subPhase;

    if (s.board && state._serverBoardKey !== JSON.stringify(s.board)) {
      Physics.reset();
      importBoardSnapshot(s.board);
      state.onlineBoardSnapshot = s.board;
      state._serverBoardKey = JSON.stringify(s.board);
    }

    state.blackScore = s.blackScore;
    state.whiteScore = s.whiteScore;
    state.currentTurn = s.currentTurn;
    state.subPhase = s.subPhase;
    state.phase = s.phase;
    state.winner = s.winner || null;
    if (typeof s.timer === 'number') state.timer = s.timer;
    if (typeof s.timerMax === 'number') state.timerMax = s.timerMax;
    state.timerPaused = !!s.timerPaused;
    state.peerAway = !!s.peerAway;
    if (s.layoutConfirmed) state.layoutConfirmed = { ...s.layoutConfirmed };

    if (s.subPhase === 'moving' && prevSubPhase !== 'moving' && state.mode === 'ONLINE') {
      clearInterval(state._timerInterval);
      state.timerActive = false;
      state._moveStartTime = performance.now();
      state._stillFrames = 0;
      state._lastMotionSeq = 0;
      clearMotionBuffer();
      _lastDebugRenderT = null;
      if (Array.isArray(s.pieces) && s.pieces.length && Array.isArray(s.pieces[0])) {
        ingestServerMotionPieces(s.pieces, s._seq, serverT, 'enter-moving');
      } else {
        seedMotionPieceStateFromPhysics();
      }
    }
    if (s.subPhase === 'waiting' && prevSubPhase === 'moving' && state.mode === 'ONLINE') {
      state._lastMotionSeq = 0;
      clearMotionBuffer();
      state._motionPieceState = null;
      state._serverClockOffset = null;
      _lastDebugRenderT = null;
    }

    if (Array.isArray(s.pieces) && s.phase !== 'layout') {
      if (state.mode === 'ONLINE' && s.subPhase === 'moving') {
        if (Array.isArray(s.pieces[0]) && !state._motionBuffer.length) {
          ingestServerMotionPieces(s.pieces, s._seq, serverT, 'game_state-moving');
        }
      } else if (Array.isArray(s.pieces[0])) {
        Physics.applyPieceMotionCompact(s.pieces, { snap: true });
        if (state.mode === 'ONLINE') {
          state._motionPieceState = s.pieces.map((r) => r.slice());
        }
      } else {
        Physics.applyPieceMotion(normalizePieces(s.pieces), { snap: true });
      }
    }

    if (s.movingPiece && s.subPhase === 'moving') {
      const [team, slotStr] = String(s.movingPiece).split(':');
      const slot = parseInt(slotStr, 10);
      state.movingPiece = Physics.getPieces().find(
        (p) => p.gameTeam === team && p.slot === slot
      ) || null;
    } else {
      state.movingPiece = null;
    }

    if (s.phase === 'layout') {
      if (!state.onlineLayoutStarted) {
        enterOnlineLayoutFromServer();
      } else {
        ensureOnlineLayoutPlacement();
      }
    } else if (s.phase === 'playing' || s.phase === 'gameover') {
      if (!state.onlineLayoutStarted) {
        state.mode = 'ONLINE';
        state.onlineRole = Online.getRole();
        state.onlineMyTeam = state.onlineRole === 'host' ? 'black' : 'white';
        state.onlineLayoutStarted = true;
        updateOnlineGameControls();
      }
    }

    if (s.phase === 'playing' && prevPhase === 'layout') {
      state.onlineBlindLayout = false;
      state.onlineWaitingOpponent = false;
      Input.disablePlacement();
      Renderer.setCameraForTurn(state.onlineMyTeam, true);
    }

    if (s.phase === 'layout' && s.layoutConfirmed && state.onlineMyTeam) {
      if (s.layoutConfirmed[state.onlineMyTeam]) {
        Input.disablePlacement();
        state.onlineWaitingOpponent = !s.layoutConfirmed.black || !s.layoutConfirmed.white;
      } else if (!state.onlineWaitingOpponent) {
        enableOnlinePlacementInput();
      }
    }

    if (s.phase === 'gameover' && s.winner) {
      handleServerGameOver(s.winner);
    }

    syncOnlineTimerFromServer();
    if (s._seq != null) state._stateSeq = s._seq;
  }

  function onMatchReady(data) {
    if (!data || !data.phase) return;
    resetOnlineSyncSeq();
    state.mode = 'ONLINE';
    state.onlineRole = Online.getRole();
    state.onlineMyTeam = state.onlineRole === 'host' ? 'black' : 'white';
    if (data.phase === 'layout' || data.phase === 'playing') {
      state.phase = data.phase;
    }
    Online.markInMatch(true);
    resizeCanvas();
    Renderer.updateBaseTransform();
    Online.requestGameStart();
  }

  function onServerGameMotion(data) {
    try {
      if (!data || !data.motion) return;
      applyServerMotion(data.motion, data.seq, data.t);
    } catch (err) {
      console.error('处理 game_motion 失败:', err);
    }
  }

  function onServerGameState(data) {
    try {
      if (!shouldAcceptGameState(data)) return;
      if (typeof data.t === 'number') updateServerClockOffset(data.t);
      if (data.seq != null && data.seq < (state._stateSeq || 0)) {
        resetOnlineSyncSeq();
      }
      const s = data.state;
      state.mode = 'ONLINE';
      applyServerState({ ...s, _seq: data.seq }, data.t);
    } catch (err) {
      console.error('处理 game_state 失败:', err);
    }
  }

  // ===== 主循环 =====
  function update(timestamp) {
    if (!state.lastTime) state.lastTime = timestamp;
    const dt = Math.min((timestamp - state.lastTime) / 1000, 0.05);
    state.lastTime = timestamp;
    state.dt = dt;

    if (state.phase === 'menu') return;

    if (state.phase === 'playing') {
      const isOnline = state.mode === 'ONLINE';
      if (!isOnline) {
        Physics.step(dt * 1000);
      }
      /* 联机行棋：服务端快照插值显示，不算本地碰撞 */
      if (isOnline && state.subPhase === 'moving') {
        applyOnlineMotionDisplay();
      }

      const inputState = Input.getState();
      const canInteract = state.subPhase === 'waiting' &&
        (state.mode !== 'ONLINE' || state.currentTurn === state.onlineMyTeam) &&
        (!isFourWay() || state.currentTurn === state.humanTeam);
      state.isDragging = canInteract && inputState.isDragging;
      state.dragWorldPos = canInteract ? inputState.dragWorldPos : null;
      if (canInteract && inputState.isDragging && inputState.selectedPiece) {
        state.selectedPiece = inputState.selectedPiece;
      } else if (!canInteract) {
        state.selectedPiece = null;
      }

      if (state.movingPiece && state.movingPiece.position) {
        const snapCam = state.mode === 'ONLINE' && state.subPhase === 'moving';
        Renderer.setCameraFollow(
          state.movingPiece.position.x,
          state.movingPiece.position.y,
          snapCam
        );
      } else {
        syncGameplayCamera();
      }

      if (state.subPhase === 'moving') {
        if (state.mode !== 'ONLINE') {
          if (Physics.allStopped()) {
            state._stillFrames = (state._stillFrames || 0) + 1;
          } else {
            state._stillFrames = 0;
          }
          const elapsed = performance.now() - (state._moveStartTime || 0);
          if (state._stillFrames >= 6 || elapsed > 5000) {
            Physics.settleAll();
            state._stillFrames = 0;
            onPiecesStopped();
          }
        }
      }
    }

    if (state.phase === 'layout') {
      if (state.mode !== 'ONLINE') {
        Physics.step(dt * 1000);
      }
    }
  }

  function hudLayoutMetrics() {
    const W = viewW();
    const H = viewH();
    const mobile = isMobileView();
    const sidePad = mobile ? 6 : 12;
    const wide = !mobile && W >= 560;

    const panelY = mobile ? 6 : 8;
    const panelH = mobile ? 54 : (wide ? 52 : 68);
    const panelW = wide
      ? Math.min(108, Math.max(84, W * 0.13))
      : (mobile ? Math.min(W * 0.22, 92) : Math.min(W * 0.16, 118));

    const scoreBottom = panelY + panelH;
    const turnBarH = mobile ? 28 : 32;
    const turnBarY = scoreBottom + (mobile ? 8 : 10);
    const hudBottom = turnBarY + turnBarH + (mobile ? 36 : 48);

    return {
      W, H, mobile, sidePad, useSingleRow: wide,
      panelW, panelH, panelY,
      scoreBottom, turnBarY, turnBarH,
      turnBarX: sidePad,
      turnBarW: W - sidePad * 2,
      hudBottom,
    };
  }

  function syncViewportInsets() {
    const mobile = isMobileView();
    if (state.phase === 'playing') {
      const hud = hudLayoutMetrics();
      Renderer.setViewportInsets(hud.hudBottom, mobile ? 28 : 36);
      return;
    }
    if (state.phase !== 'layout') {
      Renderer.setViewportInsets(0, 0);
      return;
    }
    const isAI = state.mode === '1P' && state.layoutTeam === state.aiTeam;
    if (isAI) {
      Renderer.setViewportInsets(0, 0);
      return;
    }
    const scoreBottom = (mobile ? 6 : 10) + (mobile ? 58 : 72);
    const hasBtn = state.layoutPlaced >= 6 && !state.onlineWaitingOpponent;
    const layoutBarH = hasBtn ? (mobile ? 68 : 76) : (mobile ? 48 : 54);
    Renderer.setViewportInsets(
      scoreBottom + layoutBarH + (mobile ? 8 : 10),
      mobile ? 22 : 28
    );
  }

  function render() {
    if (state.phase === 'menu') return;

    syncViewportInsets();
    Renderer.render(state);

    if (state.phase === 'playing' || state.phase === 'layout') {
      drawHUD();
    }
    if (state.phase === 'layout') {
      drawLayoutUI();
    }
    if (state.subPhase === 'combo') {
      drawComboPrompt();
    }
    if (state.phase === 'gameover') {
      drawGameOver();
    }
  }

  function createStatEntry() {
    return {
      shots: 0, hits: 0, maxCombo: 0, combo: 0,
      kills: 0,
      killByVictim: Teams.emptyKillByVictim(),
    };
  }

  function ensureStatTeam(team) {
    if (!state.stats[team]) state.stats[team] = createStatEntry();
    if (!state.stats[team].killByVictim) state.stats[team].killByVictim = Teams.emptyKillByVictim();
  }

  function recordKill(killer, victimTeam) {
    if (!killer || !victimTeam || killer === victimTeam) return;
    ensureStatTeam(killer);
    const s = state.stats[killer];
    s.kills = (s.kills || 0) + 1;
    s.killByVictim[victimTeam] = (s.killByVictim[victimTeam] || 0) + 1;
  }

  function killStatTeams() {
    return isFourWay() ? Teams.TURN_ORDER : ['black', 'white'];
  }

  function ffaScaledCount(min, randSpan, mult) {
    const base = min + Math.floor(Math.random() * (randSpan + 1));
    return Math.max(min, Math.round(base * mult));
  }
    const base = min + Math.floor(Math.random() * (randSpan + 1));
    return Math.max(min, Math.round(base * mult));
  }

  function setupRandomBoard() {
    const ffa = isFourWay();
    const obsCount = ffa
      ? ffaScaledCount(1, 2, Teams.FFA_OBSTACLE_MULT)
      : 1 + Math.floor(Math.random() * 3);
    const ww = Physics.W;
    const placed = [];
    for (let i = 0; i < obsCount; i++) {
      let ox, oy, tries = 0;
      do {
        ox = ww.centerX + (Math.random() - 0.5) * 240;
        oy = ww.centerY + (Math.random() - 0.5) * 180;
        tries++;
      } while (tries < 60 && (
        Math.hypot(ox - ww.centerX, oy - ww.centerY) < ww.domeRadius + 35 ||
        placed.some(p => Math.hypot(p.x - ox, p.y - oy) < 65)
      ));
      Physics.createObstacle(ox, oy);
      placed.push({ x: ox, y: oy });
    }
    if (state.gameType === 'fun') {
      generateFunItems(placed);
    }
    return placed;
  }

  function exportBoardSnapshot() {
    return {
      obstacles: Physics.getObstacles().map(o => ({ x: o.position.x, y: o.position.y })),
      walls: Physics.getWalls().map(w => ({
        x: w.position.x, y: w.position.y, len: w.wallLen, horizontal: w.wallHorizontal,
      })),
      blocks: Physics.getBlocks().map(b => ({ x: b.position.x, y: b.position.y, size: b.blockSize })),
      holes: Physics.getHoles().map(h => ({ x: h.x, y: h.y, r: h.r })),
    };
  }

  function importBoardSnapshot(snap) {
    if (!snap) return;
    (snap.obstacles || []).forEach(o => Physics.createObstacle(o.x, o.y));
    (snap.walls || []).forEach(w => Physics.createWall(w.x, w.y, w.len, w.horizontal));
    (snap.blocks || []).forEach(b => Physics.createBlock(b.x, b.y, b.size));
    (snap.holes || []).forEach(h => Physics.addHole(h.x, h.y, h.r));
  }

  function exportOnlineSync() {
    return {
      blackScore: state.blackScore,
      whiteScore: state.whiteScore,
      currentTurn: state.currentTurn,
      subPhase: state.subPhase,
      phase: state.phase,
      winner: state.winner,
      timer: state.timer,
      timerPaused: state.timerPaused,
      peerAway: state.peerAway,
      pieces: Physics.getPieces().map(p => ({
        team: p.gameTeam,
        slot: p.slot,
        x: p.position.x,
        y: p.position.y,
        vx: p.velocity.x,
        vy: p.velocity.y,
        special: p.special || null,
      })),
    };
  }

  function applyOnlineSync(payload) {
    if (!payload) return;
    state._motionTargets = null;
    state.blackScore = payload.blackScore;
    state.whiteScore = payload.whiteScore;
    state.currentTurn = payload.currentTurn;
    state.subPhase = payload.subPhase;
    state.phase = payload.phase;
    state.movingPiece = null;
    state.selectedPiece = null;
    state.isDragging = false;
    Input.reset();
    const map = {};
    Physics.getPieces().forEach(p => { map[`${p.gameTeam}:${p.slot}`] = p; });
    (payload.pieces || []).forEach(info => {
      const key = `${info.team}:${info.slot}`;
      let body = map[key];
      if (!body) {
        body = Physics.createPiece(info.x, info.y, info.team, info.slot);
        map[key] = body;
      }
      Matter.Body.setPosition(body, { x: info.x, y: info.y });
      Matter.Body.setVelocity(body, { x: info.vx || 0, y: info.vy || 0 });
      body.special = info.special || null;
    });
    const live = new Set((payload.pieces || []).map(p => `${p.team}:${p.slot}`));
    Physics.getPieces().slice().forEach(p => {
      if (!live.has(`${p.gameTeam}:${p.slot}`)) Physics.removePiece(p);
    });
    if (payload.phase === 'gameover' && payload.winner) {
      state.winner = payload.winner;
      clearInterval(state._timerInterval);
      state.phase = 'gameover';
    }
    if (typeof payload.timer === 'number') state.timer = payload.timer;
    if (typeof payload.timerPaused === 'boolean') state.timerPaused = payload.timerPaused;
    if (typeof payload.peerAway === 'boolean') state.peerAway = payload.peerAway;
    syncOnlinePhysicsMode();
    if (state.phase === 'playing') {
      if (state.subPhase === 'waiting') {
        if (state.timerPaused) pauseGameTimer(false);
        else resumeGameTimer(false);
      } else {
        clearInterval(state._timerInterval);
        state.timerActive = false;
      }
    }
  }

  const LS_LOCAL_MATCH = 'tanqiLocalMatch';

  function persistLocalMatch() {
    if (state.mode !== 'ONLINE') return;
    if (state.phase !== 'playing' && state.phase !== 'layout') return;
    try {
      sessionStorage.setItem(LS_LOCAL_MATCH, JSON.stringify({
        onlineRole: state.onlineRole,
        onlineMyTeam: state.onlineMyTeam,
        onlineLayoutStarted: state.onlineLayoutStarted,
        onlineBoardSnapshot: state.onlineBoardSnapshot,
        onlineLayouts: state.onlineLayouts,
        onlineBlindLayout: state.onlineBlindLayout,
        phase: state.phase,
        subPhase: state.subPhase,
        sync: state.phase === 'playing' ? exportOnlineSync() : null,
      }));
    } catch { /* ignore */ }
  }

  function restoreLocalMatch() {
    try {
      const raw = sessionStorage.getItem(LS_LOCAL_MATCH);
      if (!raw) return false;
      const data = JSON.parse(raw);
      state.mode = 'ONLINE';
      state.onlineRole = data.onlineRole;
      state.onlineMyTeam = data.onlineMyTeam;
      state.onlineLayoutStarted = !!data.onlineLayoutStarted;
      state.onlineBoardSnapshot = data.onlineBoardSnapshot || null;
      state.onlineLayouts = data.onlineLayouts || { black: null, white: null };
      state.onlineBlindLayout = !!data.onlineBlindLayout;
      if (data.phase === 'playing' && data.sync) {
        applyOnlineSync(data.sync);
        syncOnlinePhysicsMode();
        Renderer.setCameraForTurn(state.onlineMyTeam, true);
        return true;
      }
      if (data.phase === 'layout' && data.onlineBoardSnapshot) {
        state.phase = 'layout';
        importBoardSnapshot(data.onlineBoardSnapshot);
        state._serverBoardKey = JSON.stringify(data.onlineBoardSnapshot);
        ensureOnlineLayoutPlacement();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function clearLocalMatch() {
    try { sessionStorage.removeItem(LS_LOCAL_MATCH); } catch { /* ignore */ }
  }

  function updateOnlineGameControls() {
    const onlineEl = document.getElementById('online-game-controls');
    const spEl = document.getElementById('sp-game-controls');
    const inGame = state.phase === 'playing' || state.phase === 'layout';
    if (onlineEl) {
      onlineEl.classList.toggle('hidden', !(state.mode === 'ONLINE' && inGame));
    }
    if (spEl) {
      spEl.classList.toggle('hidden', !(state.mode === '1P' && inGame));
    }
  }

  function setPeerAway(away) {
    state.peerAway = !!away;
  }

  function pauseGameTimer(notifyPeer) {
    if (state.mode === 'ONLINE') return;
    if (state.timerPaused) return;
    clearInterval(state._timerInterval);
    state._timerInterval = null;
    state.timerActive = false;
    state.timerPaused = true;
    persistLocalMatch();
    if (notifyPeer !== false && state.mode === 'ONLINE' && state.onlineRole === 'host') {
      Online.relay({ type: 'sync', sync: exportOnlineSync() });
    }
  }

  function resumeGameTimer(notifyPeer) {
    if (state.mode === 'ONLINE') return;
    if (!state.timerPaused && state.timerActive) return;
    if (state.phase !== 'playing' || state.subPhase !== 'waiting') return;
    if (state.peerAway) return;
    state.timerPaused = false;
    startTimerInterval();
    persistLocalMatch();
    if (notifyPeer !== false && state.mode === 'ONLINE' && state.onlineRole === 'host') {
      Online.relay({ type: 'sync', sync: exportOnlineSync() });
    }
  }

  function startTimerInterval() {
    clearInterval(state._timerInterval);
    state.timerActive = true;
    const hostAuthoritative = state.mode !== 'ONLINE' || state.onlineRole === 'host';
    state._timerInterval = setInterval(() => {
      if (state.timerPaused || state.peerAway) return;
      if (state.subPhase !== 'waiting' || state.phase !== 'playing') return;
      if (state.mode === 'ONLINE' && state.currentTurn !== state.onlineMyTeam) return;
      state.timer--;
      if (state.timer <= 0) {
        clearInterval(state._timerInterval);
        state.timerActive = false;
        if (hostAuthoritative) nextTurn();
      }
    }, 1000);
  }

  function resetOnlineMatchState() {
    state.onlineRole = null;
    state.onlineMyTeam = null;
    state.onlineBlindLayout = false;
    state.onlineLayouts = { black: null, white: null };
    state.onlineWaitingOpponent = false;
    state.onlineLayoutStarted = false;
    state.onlineBoardSnapshot = null;
    state._serverBoardKey = null;
    state._stateSeq = 0;
    state._lastMotionSeq = 0;
    clearMotionBuffer();
    state.timerPaused = false;
    state.peerAway = false;
    Physics.setVisualOnly(false);
    clearLocalMatch();
  }

  function resetOnlineSyncSeq() {
    state._stateSeq = 0;
    state._lastMotionSeq = 0;
  }

  function shouldAcceptGameState(data) {
    if (!data?.state) return false;
    const seq = data.seq;
    if (seq == null) return true;
    const last = state._stateSeq || 0;
    if (seq > last) return true;
    if (seq === last) return false;
    /* 新对局 seq 从 1 重新计数，旧会话 seq 较大时会误判为过期包 */
    return !!(data.full || data.state.board);
  }

  function initOnlineBase() {
    state.mode = 'ONLINE';
    state.gameType = 'fun';
    state.blackScore = 0;
    state.whiteScore = 0;
    state.winner = null;
    state.currentTurn = 'black';
    state.layoutConfirmed = { black: false, white: false };
    state.replayData = [];
    state.stats = {
      black: createStatEntry(),
      white: createStatEntry(),
    };
    Physics.reset();
  }

  function startOnlineLayoutPhase() {
    ensureOnlineLayoutPlacement();
  }

  function startOnlineAsHost() {
    initOnlineBase();
    state.onlineRole = 'host';
    state.onlineMyTeam = 'black';
    setupRandomBoard();
    Audio.startAmbient();
    Audio.scrollOpen();
    startOnlineLayoutPhase();
  }

  function startOnlineAsGuest(boardSnap) {
    initOnlineBase();
    state.onlineRole = 'guest';
    state.onlineMyTeam = 'white';
    importBoardSnapshot(boardSnap);
    Audio.startAmbient();
    Audio.scrollOpen();
    startOnlineLayoutPhase();
    Online.markInMatch(true);
    persistLocalMatch();
    updateOnlineGameControls();
  }

  function hostStartOnlineMatch() {
    // 服务端在双方加入后自动开局，客户端等待 game_state
  }

  function onPeerJoinedOnline() {
    // 服务端自动开局
  }

  function onGuestJoinedOnline() {
    // 客机保持在大厅，收到 board_setup 后由 onOnlineMessage 切入布子画面
  }

  function tryStartOnlineGameFromHost() {
    if (state.onlineRole !== 'host') return;
    if (!state.onlineLayouts.black || !state.onlineLayouts.white) return;
    Physics.getPieces().slice().forEach(p => Physics.removePiece(p));
    state.onlineLayouts.black.forEach((p, i) => Physics.createPiece(p.x, p.y, 'black', i));
    state.onlineLayouts.white.forEach((p, i) => Physics.createPiece(p.x, p.y, 'white', i));
    tagSpecials('black');
    tagSpecials('white');
    state.layoutConfirmed = { black: true, white: true };
    state.onlineBlindLayout = false;
    beginGame();
    Online.relay({ type: 'game_begin', sync: exportOnlineSync() });
  }

  function confirmOnlineLayout() {
    if (state.layoutPlaced < 6) return;
    const team = state.onlineMyTeam;
    const pieces = Physics.getPieces()
      .filter(p => p.gameTeam === team)
      .sort((a, b) => a.slot - b.slot)
      .map(p => ({ x: p.position.x, y: p.position.y }));
    tagSpecials(team);
    state.layoutConfirmed[team] = true;
    Input.disablePlacement();
    Audio.scrollOpen();
    state.onlineLayouts[team] = pieces;
    Online.sendGameAction({ type: 'layout_done', pieces });
    state.onlineWaitingOpponent = true;
  }

  function onOnlineMessage(data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case 'peer_joined':
        if (state.mode === 'ONLINE' && (state.phase === 'playing' || state.phase === 'layout')) {
          setPeerAway(false);
          state.timerPaused = false;
          if (state.onlineRole === 'host') resumeGameTimer(false);
        }
        break;
      case 'peer_left':
        if (data.temporary) {
          setPeerAway(true);
          pauseGameTimer(state.onlineRole === 'host');
          return;
        }
        if (state.phase === 'playing' || state.phase === 'layout') {
          Online.markInMatch(false);
          clearLocalMatch();
          clearInterval(state._timerInterval);
          state.timerPaused = false;
          state.peerAway = false;
          state.phase = 'menu';
          state.onlineLayoutStarted = false;
          state.onlineBlindLayout = false;
          Physics.setVisualOnly(false);
          Audio.stopAmbient();
          updateOnlineGameControls();
          alert('对方已退出对局');
          if (Online.isConnected()) showScreen('online-lobby');
          else showMainMenu(true);
        }
        break;
      case 'host_migrated':
      case 'role_changed':
        if (Online.getRole() === 'host') state.onlineRole = 'host';
        else if (Online.getRole() === 'guest') state.onlineRole = 'guest';
        break;
      case 'host_offline':
        if (state.mode === 'ONLINE' && state.phase === 'playing') {
          setPeerAway(true);
          pauseGameTimer(false);
        }
        break;
      case 'host_online':
        if (state.mode === 'ONLINE' && state.phase === 'playing' && state.peerAway) {
          setPeerAway(false);
          if (state.onlineRole === 'host') resumeGameTimer(true);
        }
        break;
      case 'error':
        if (data.message) alert(data.message);
        break;
      default:
        break;
    }
  }

  // ===== 开始新游戏 =====
  function startGame(mode, aiLevel, boardSkin, pieceSkin, gameType) {
    state.matchMode = '2P';
    Renderer.setFFAViewMode(false);
    state.mode     = mode     || '2P';
    state.gameType = gameType || 'classic';
    state.aiLevel  = aiLevel  || 2;
    state.aiTeam   = 'white';
    state.humanTeam = 'white';
    state.aiTeams = ['black', 'red', 'blue'];
    state.eliminated = null;

    state.boardSkin = boardSkin || state.boardSkin;
    state.pieceSkin = pieceSkin || state.pieceSkin;

    state.blackScore = 0;
    state.whiteScore = 0;
    state.winner = null;
    state.currentTurn = 'black';
    state.layoutConfirmed = { black: false, white: false };
    state.replayData = [];
    state.stats = {
      black: createStatEntry(),
      white: createStatEntry(),
    };

    Physics.reset();

    setupRandomBoard();

    Audio.startAmbient();
    Audio.scrollOpen();
    startLayoutPhase('black');
    updateOnlineGameControls();
  }

  function startFourWayGame(boardSkin, pieceSkin) {
    state.matchMode = '4FFA';
    Renderer.setFFAViewMode(true);
    state.mode = '1P';
    state.gameType = 'fun';
    state.aiLevel = Teams.MASTER_AI_LEVEL;
    state.humanTeam = Teams.HUMAN_TEAM;
    state.aiTeams = Teams.AI_TEAMS.slice();
    state.aiTeam = state.aiTeams[0];
    state.eliminated = new Set();

    state.boardSkin = boardSkin || state.boardSkin;
    state.pieceSkin = pieceSkin || state.pieceSkin;

    state.blackScore = 0;
    state.whiteScore = 0;
    state.winner = null;
    state.currentTurn = Teams.HUMAN_TEAM;
    state.layoutConfirmed = Teams.initLayoutConfirmed();
    state.replayData = [];
    state.stats = Teams.initStats();

    Physics.reset();
    setupRandomBoard();

    Audio.startAmbient();
    Audio.scrollOpen();
    startLayoutPhase(Teams.HUMAN_TEAM);
    updateOnlineGameControls();
  }

  // ===== 趣味局：随机生成反弹墙、陷洞、固定阻块 =====
  function generateFunItems(obstaclePositions) {
    const ww = Physics.W;
    const ffa = isFourWay();
    const wallMult = ffa ? Teams.FFA_WALL_LEN_MULT : 1;
    const objMult = ffa ? Teams.FFA_OBJECT_MULT : 1;
    const occupied = (obstaclePositions || []).map(p => ({ x: p.x, y: p.y, r: 40 }));
    const farEnough = (x, y, r) =>
      Math.hypot(x - ww.centerX, y - ww.centerY) > ww.domeRadius + r + 10 &&
      occupied.every(o => Math.hypot(o.x - x, o.y - y) > o.r + r);

    // —— 反弹墙：沿边界，四国模式总长 +30% ——
    const perimeter = ww.boardSize * 4;
    const targetWallLen = (perimeter / 3) * wallMult;
    const inset = 7;
    const edges = [
      { horizontal: true,  fixed: ww.boardTop    + inset },
      { horizontal: true,  fixed: ww.boardBottom - inset },
      { horizontal: false, fixed: ww.boardLeft   + inset },
      { horizontal: false, fixed: ww.boardRight  - inset },
    ];
    let wallTotal = 0, guard = 0;
    const wallGuardMax = ffa ? 40 : 30;
    while (wallTotal < targetWallLen && guard++ < wallGuardMax) {
      const e = edges[Math.floor(Math.random() * edges.length)];
      const len = 70 + Math.random() * 110;
      const lo = (e.horizontal ? ww.boardLeft : ww.boardTop) + len / 2 + 6;
      const hi = (e.horizontal ? ww.boardRight : ww.boardBottom) - len / 2 - 6;
      const c = lo + Math.random() * (hi - lo);
      const x = e.horizontal ? c : e.fixed;
      const y = e.horizontal ? e.fixed : c;
      Physics.createWall(x, y, len, e.horizontal);
      wallTotal += len;
    }

    // —— 固定阻块：四国模式数量 +40% ——
    const blockCount = ffa ? ffaScaledCount(2, 1, objMult) : 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < blockCount; i++) {
      for (let t = 0; t < 50; t++) {
        const x = ww.centerX + (Math.random() - 0.5) * 320;
        const y = ww.centerY + (Math.random() - 0.5) * 240;
        if (farEnough(x, y, 30)) { Physics.createBlock(x, y); occupied.push({ x, y, r: 30 }); break; }
      }
    }

    // —— 陷洞：固定 2 个（四国模式也不增加）——
    const holeCount = 2;
    const holeR = ww.pieceRadius * 2;
    for (let i = 0; i < holeCount; i++) {
      for (let t = 0; t < 60; t++) {
        const x = ww.boardLeft + 50 + Math.random() * (ww.boardSize - 100);
        const y = ww.centerY + (Math.random() - 0.5) * 30;
        if (farEnough(x, y, holeR + 6)) { Physics.addHole(x, y, holeR); occupied.push({ x, y, r: holeR + 20 }); break; }
      }
    }
  }

  // 趣味局：把落在陷洞/阻块上的 AI 落子轻推到安全位置
  function sanitizeAILayout(positions, team) {
    const ww = Physics.W;
    const R = ww.pieceRadius;
    const zone = isFourWay() ? Teams.getLayoutZone(team, ww) : null;
    const zoneTop = zone ? zone.yMin : (team === 'white' ? ww.boardTop + 15 : ww.boardTop + ww.boardSize * 0.6);
    const zoneBottom = zone ? zone.yMax : (team === 'white' ? ww.boardTop + ww.boardSize * 0.4 : ww.boardBottom - 15);
    const zoneLeft = zone ? zone.xMin : ww.boardLeft + 20;
    const zoneRight = zone ? zone.xMax : ww.boardRight - 20;
    const bad = (x, y) => {
      if (x < zoneLeft || x > zoneRight || y < zoneTop || y > zoneBottom) return true;
      return Physics.getHoles().some(h => Math.hypot(h.x - x, h.y - y) < h.r + R) ||
        Physics.getBlocks().some(b => Math.hypot(b.position.x - x, b.position.y - y) < (b.blockSize || 26) * 0.7 + R);
    };
    return positions.map(p => {
      let { x, y } = p;
      for (let t = 0; t < 40 && bad(x, y); t++) {
        x = zoneLeft + Math.random() * (zoneRight - zoneLeft);
        y = zoneTop + Math.random() * (zoneBottom - zoneTop);
      }
      return { x, y };
    });
  }

  // 趣味局 / 四方乱战：标记特殊棋与主将（slot0=主将，倒二=曲线，末=疾行）
  function tagTeamPieces(team) {
    const pcs = Physics.getPieces()
      .filter(p => p.gameTeam === team)
      .sort((a, b) => a.slot - b.slot);
    pcs.forEach(p => {
      p.special = null;
      p.isGeneral = false;
    });
    if (isFourWay()) {
      if (pcs.length >= 1) pcs[0].isGeneral = true;
      if (pcs.length >= 2) pcs[pcs.length - 2].special = 'curve';
      if (pcs.length >= 1) pcs[pcs.length - 1].special = 'speed';
      return;
    }
    if (state.gameType !== 'fun') return;
    if (pcs.length >= 2) {
      pcs[pcs.length - 2].special = 'curve';
      pcs[pcs.length - 1].special = 'speed';
    }
  }

  function tagSpecials(team) {
    tagTeamPieces(team);
  }

  function autoLayoutTeam(team) {
    const existing = Physics.getPieces();
    let positions = AI.computeLayout(team, existing);
    if (state.gameType === 'fun' || isFourWay()) positions = sanitizeAILayout(positions, team);
    positions.forEach((p, i) => Physics.createPiece(p.x, p.y, team, i));
    tagTeamPieces(team);
    state.layoutConfirmed[team] = true;
  }

  function advanceLayoutPhase() {
    const next = isFourWay()
      ? Teams.nextLayoutTeam(state.layoutConfirmed)
      : (state.layoutTeam === 'black' ? 'white' : 'black');
    if (next && !state.layoutConfirmed[next]) {
      startLayoutPhase(next);
    } else {
      beginGame();
    }
  }

  // ===== 布局阶段 =====
  function startLayoutPhase(team) {
    state.phase = 'layout';
    state.layoutTeam = team;
    state.layoutPlaced = Physics.getPieces().filter(p => p.gameTeam === team).length;
    state._confirmBtnRect = null;
    if (isFourWay()) Renderer.setCameraForFFA(true);
    else Renderer.setCameraOverview();

    if (isFourWay() && isAiTeam(team)) {
      autoLayoutTeam(team);
      advanceLayoutPhase();
      return;
    }

    if (state.mode === '1P' && !isFourWay() && team === state.aiTeam) {
      autoLayoutTeam(team);
      advanceLayoutPhase();
      return;
    }

    Input.enablePlacement(team, (wx, wy) => {
      if (state.layoutPlaced >= 6) return;
      const R = Physics.W.pieceRadius;
      const tooClose = Physics.getPieces().some(p =>
        Math.hypot(p.position.x - wx, p.position.y - wy) < R * 2.5
      );
      if (tooClose) return;
      const onHole = Physics.getHoles().some(h =>
        Math.hypot(h.x - wx, h.y - wy) < h.r + R
      );
      const onBlock = Physics.getBlocks().some(b =>
        Math.hypot(b.position.x - wx, b.position.y - wy) < (b.blockSize || 26) * 0.7 + R
      );
      if (onHole || onBlock) return;
      Physics.createPiece(wx, wy, team, state.layoutPlaced);
      state.layoutPlaced++;
      Audio.uiClick();
    });
  }

  function confirmLayout() {
    if (state.mode === 'ONLINE') {
      confirmOnlineLayout();
      return;
    }
    if (state.layoutPlaced < 6) return;
    tagTeamPieces(state.layoutTeam);
    state.layoutConfirmed[state.layoutTeam] = true;
    Input.disablePlacement();
    Audio.scrollOpen();
    advanceLayoutPhase();
  }

  function beginGame() {
    state.phase = 'playing';
    state.subPhase = 'waiting';
    state.currentTurn = isFourWay() ? state.humanTeam : 'black';
    state.hitThisTurn = false;
    state.selectedPiece = null;
    state.movingPiece = null;
    syncOnlinePhysicsMode();
    if (isFourWay()) {
      Renderer.setCameraForFFA(true);
    } else if (state.mode === '2P') {
      Renderer.setCameraOverview();
      Renderer.setCameraForTurn('black', true);
    } else if (state.mode === 'ONLINE') {
      Renderer.setCameraOverview();
      Renderer.setCameraForTurn(state.onlineMyTeam, true);
      Online.markInMatch(true);
      persistLocalMatch();
      updateOnlineGameControls();
    } else {
      Renderer.setCameraOverview();
    }
    startTimer();

    if (isAiTeam(state.currentTurn)) {
      scheduleAIMove();
    }
  }

  // ===== 回合 =====
  function startTimer(reset) {
    clearInterval(state._timerInterval);
    if (reset !== false) state.timer = state.timerMax;
    state.timerPaused = false;
    if (state.mode === 'ONLINE' && state.peerAway) {
      state.timerActive = false;
      state.timerPaused = true;
      return;
    }
    startTimerInterval();
  }

  function doFling(piece, fx, fy, strength) {
    clearInterval(state._timerInterval);
    state.timerActive = false;
    state.stats[state.currentTurn].shots++;
    state.hitThisTurn = false;
    state.scoredThisTurn = false;
    state.movingPiece = piece;
    state.subPhase = 'moving';
    state.selectedPiece = null;
    state._moveStartTime = performance.now();
    state._stillFrames = 0;

    Physics.flingPiece(piece, fx, fy);

    state.replayData.push({
      team: piece.gameTeam,
      pieceIdx: Physics.getPieces().indexOf(piece),
      fx, fy, timestamp: Date.now(),
    });
  }

  function onPiecesStopped() {
    if (state.mode === 'ONLINE') return;
    state.movingPiece = null;
    syncGameplayCamera();

    if (isFourWay() && state.eliminated.has(state.currentTurn)) {
      state.stats[state.currentTurn].combo = 0;
      nextTurn();
      return;
    }

    if (state.scoredThisTurn) {
      const s = state.stats[state.currentTurn];
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      // 仅当本回合把对方棋子打下盘才连击：玩家与 AI 均自动继续出手
      acceptCombo();
    } else {
      state.stats[state.currentTurn].combo = 0;
      nextTurn();
    }
  }

  function acceptCombo() {
    clearInterval(state._comboInterval);
    state.subPhase = 'waiting';
    state.hitThisTurn = false;
    state._comboBtnRects = null;
    startTimer();
    if (isAiTeam(state.currentTurn)) {
      scheduleAIMove();
    }
  }

  function skipCombo() {
    clearInterval(state._comboInterval);
    state._comboBtnRects = null;
    state.stats[state.currentTurn].combo = 0;
    nextTurn();
  }

  function nextTurn() {
    state.subPhase = 'waiting';
    state.hitThisTurn = false;

    if (isFourWay()) {
      let next = Teams.nextTurnTeam(state.currentTurn, state.eliminated);
      while (next && (!teamHasPieces(next) || !teamHasGeneral(next))) {
        if (next) state.eliminated.add(next);
        if (checkFFAWinCondition()) return;
        next = Teams.nextTurnTeam(next, state.eliminated);
      }
      if (!next || checkFFAWinCondition()) return;
      state.currentTurn = next;
      state.selectedPiece = null;
      syncGameplayCamera();
      startTimer();
      if (isAiTeam(state.currentTurn)) scheduleAIMove();
      return;
    }

    state.currentTurn = state.currentTurn === 'black' ? 'white' : 'black';
    state.selectedPiece = null;
    if (state.mode === '2P') {
      Renderer.setCameraOverview();
      Renderer.setCameraForTurn(state.currentTurn, true);
    } else if (state.mode === 'ONLINE') {
      Renderer.setCameraForTurn(state.onlineMyTeam, true);
    }
    startTimer();

    if (isAiTeam(state.currentTurn)) {
      scheduleAIMove();
    }
  }

  function transferTeamPieces(fromTeam, toTeam) {
    Physics.getPieces().filter(p => p.gameTeam === fromTeam).forEach(p => {
      p.gameTeam = toTeam;
      p.label = toTeam;
    });
  }

  function removeTeamPieces(team) {
    Physics.getPieces().filter(p => p.gameTeam === team).forEach(p => Physics.removePiece(p));
  }

  function showEliminationFlash(fallenTeam, eliminator) {
    const el = document.getElementById('score-flash');
    if (!el) return;
    if (eliminator && eliminator !== fallenTeam) {
      el.textContent = `${Teams.getName(fallenTeam)} 主将落盘 · ${Teams.getName(eliminator)} 收编`;
    } else {
      el.textContent = `${Teams.getName(fallenTeam)} 主将落盘 · 出局`;
    }
    el.style.color = '#5a1810';
    el.style.textShadow = '0 2px 8px rgba(0,0,0,0.35)';
    el.classList.remove('hidden', 'show');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }

  function checkFFAWinCondition() {
    if (!isFourWay()) return false;
    const alive = Teams.TURN_ORDER.filter(t =>
      !state.eliminated.has(t) && teamHasPieces(t) && teamHasGeneral(t)
    );
    if (alive.length === 1) {
      declareWinner(alive[0]);
      return true;
    }
    if (alive.length === 0) {
      declareWinner(state.humanTeam);
      return true;
    }
    return false;
  }

  function handleGeneralFallFFA(body, fallenTeam) {
    const fallX = body.position.x;
    const fallY = body.position.y;
    const eliminator = state.currentTurn;

    Renderer.addFallAnimation(fallX, fallY, fallenTeam);
    Physics.removePiece(body);
    Audio.pieceFall();

    if (eliminator !== fallenTeam) {
      recordKill(eliminator, fallenTeam);
    }

    if (!state.eliminated.has(fallenTeam)) {
      state.eliminated.add(fallenTeam);
      if (eliminator !== fallenTeam && teamHasPieces(fallenTeam)) {
        transferTeamPieces(fallenTeam, eliminator);
        state.scoredThisTurn = true;
      } else {
        removeTeamPieces(fallenTeam);
      }
      showEliminationFlash(fallenTeam, eliminator !== fallenTeam ? eliminator : null);
    }

    if (checkFFAWinCondition()) return;

    if (state.eliminated.has(state.currentTurn) && state.subPhase !== 'moving') {
      nextTurn();
    }
  }

  function handlePieceFallFFA(body) {
    const fallX = body.position.x;
    const fallY = body.position.y;
    const fallenTeam = body.gameTeam;

    if (body.isGeneral) {
      handleGeneralFallFFA(body, fallenTeam);
      return;
    }

    if (fallenTeam !== state.currentTurn) {
      state.scoredThisTurn = true;
      recordKill(state.currentTurn, fallenTeam);
    }

    Renderer.addFallAnimation(fallX, fallY, fallenTeam);
    Physics.removePiece(body);
    Audio.pieceFall();

    if (checkFFAWinCondition()) return;

    if (!teamHasPieces(state.currentTurn) && state.subPhase !== 'moving') {
      nextTurn();
    }
  }

  // ===== 落盘 =====
  function handlePieceFall(body) {
    if (!Physics.getPieces().includes(body)) return;
    if (state.phase !== 'playing') return;
    if (state.mode === 'ONLINE' && state.onlineRole === 'guest') return;

    if (isFourWay()) {
      handlePieceFallFFA(body);
      return;
    }

    const fallX = body.position.x;
    const fallY = body.position.y;
    const fallenTeam = body.gameTeam;

    if (fallenTeam === 'black') state.whiteScore++;
    else state.blackScore++;

    if (state.phase === 'playing' && fallenTeam !== state.currentTurn) {
      state.scoredThisTurn = true;
      recordKill(state.currentTurn, fallenTeam);
    }

    Renderer.addFallAnimation(fallX, fallY, fallenTeam);
    Physics.removePiece(body);
    Audio.pieceFall();
    showScoreFlash(fallenTeam === 'black' ? 'white' : 'black');

    if (checkWinCondition()) return;

    const myPieces = Physics.getPieces().filter(p => p.gameTeam === state.currentTurn);
    if (myPieces.length === 0) {
      declareWinner(state.currentTurn === 'black' ? 'white' : 'black');
    }
  }

  function checkWinCondition() {
    if (state.blackScore >= state.winScore) { declareWinner('black'); return true; }
    if (state.whiteScore >= state.winScore) { declareWinner('white'); return true; }
    return false;
  }

  function declareWinner(team) {
    clearInterval(state._timerInterval);
    clearInterval(state._comboInterval);
    state.phase = 'gameover';
    state.subPhase = 'waiting';
    state.winner = team;
    state._killStatsExpanded = false;
    state._killStatsToggleRect = null;
    state.timerPaused = false;
    state.peerAway = false;
    if (state.mode === 'ONLINE') {
      Online.markInMatch(false);
      clearLocalMatch();
    }
    // 结算寄语只在此时选定一次，避免每帧随机导致高速闪烁
    const isWinnerHuman = isFourWay()
      ? team === state.humanTeam
      : (state.mode === '2P' || state.mode === 'ONLINE' || team !== state.aiTeam);
    const poems = DATA.endingPoems[isWinnerHuman ? 'win' : 'lose'];
    state._endingPoem = poems[Math.floor(Math.random() * poems.length)];
    Audio.victory();
  }

  // ===== AI =====
  function scheduleAIMove() {
    const level = getAiLevel();
    const baseSec = [0, 1.6, 2.4][level] || 1.6;
    const delay = baseSec * 1000 + Math.random() * 1000;
    const aiTeam = state.currentTurn;
    setTimeout(async () => {
      if (state.phase !== 'playing' || state.currentTurn !== aiTeam || state.subPhase !== 'waiting') return;
      if (!isAiTeam(aiTeam)) return;
      let move = null;
      try {
        move = AI.computeMove(level, aiTeam);
      } catch (err) {
        console.error('AI 计算出错，改用随机弹射：', err);
      }
      if (state.phase !== 'playing' || state.currentTurn !== aiTeam || state.subPhase !== 'waiting') return;
      if (!move) {
        const mine = Physics.getPieces().filter(p => p.gameTeam === aiTeam);
        if (mine.length === 0) { nextTurn(); return; }
        const piece = mine[Math.floor(Math.random() * mine.length)];
        const ang = Math.random() * Math.PI * 2;
        const f = 0.012 + Math.random() * 0.01;
        move = { piece, fx: Math.cos(ang) * f, fy: Math.sin(ang) * f, strength: 0.6 };
      }
      doFling(move.piece, move.fx, move.fy, move.strength);
    }, delay);
  }

  // ===== HUD Canvas 渲染 =====
  function getCtx() {
    const ctx = canvas.getContext('2d');
    const dpr = canvas._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function getTurnBannerText() {
    if (state.phase !== 'playing') return '';
    if (isFourWay()) {
      if (state.subPhase === 'moving') {
        return isHumanTurn() ? '行棋中…' : `${Teams.getName(state.currentTurn)} 行棋…`;
      }
      return isHumanTurn() ? '轮汝出手' : `${Teams.getName(state.currentTurn)} 行棋…`;
    }
    const isMyTurn = isHumanTurn();
    if (state.subPhase === 'moving') {
      return isMyTurn ? '行棋中…' : '对方行棋…';
    }
    return isMyTurn ? '轮汝出手' : '对方行棋…';
  }

  function roundRect2(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function drawFFATeamPanel(ctx, x, y, w, h, teamId) {
    const eliminated = state.eliminated && state.eliminated.has(teamId);
    const count = Physics.getPieces().filter(p => p.gameTeam === teamId).length;
    const hasGen = teamHasGeneral(teamId);
    const active = state.currentTurn === teamId && state.phase === 'playing';

    ctx.save();
    ctx.globalAlpha = eliminated ? 0.45 : 1;
    ctx.fillStyle = active ? 'rgba(255,248,220,0.98)' : 'rgba(245,232,200,0.94)';
    roundRect2(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(190,130,30,0.95)' : 'rgba(140,90,20,0.75)';
    ctx.lineWidth = active ? 2 : 1.2;
    roundRect2(ctx, x, y, w, h, 5);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = Teams.isDarkTeam(teamId) ? '#0A0402' : '#1A0E04';
    const fs = Math.max(9, Math.round(h * 0.22));
    ctx.font = `bold ${fs}px "Noto Serif SC", SimSun, serif`;
    const label = eliminated ? '出局' : `${count}子`;
    ctx.fillText(Teams.getName(teamId), x + w / 2, y + h * 0.38);
    ctx.font = `${Math.max(8, fs - 1)}px "Noto Serif SC", SimSun, serif`;
    ctx.fillStyle = '#4A3010';
    ctx.fillText(eliminated ? '—' : (hasGen ? `将·${label}` : label), x + w / 2, y + h * 0.78);
    ctx.restore();
  }

  function drawHUD() {
    const ctx = getCtx();
    const hud = hudLayoutMetrics();
    const {
      W, H, mobile, sidePad, useSingleRow,
      panelW, panelH, panelY,
      turnBarY, turnBarH, turnBarX, turnBarW,
    } = hud;
    ctx.save();

    if (isFourWay()) {
      const gap = mobile ? 4 : 6;
      const pw = (W - sidePad * 2 - gap * 3) / 4;
      const ph = panelH;
      Teams.TURN_ORDER.forEach((teamId, i) => {
        const x = sidePad + i * (pw + gap);
        drawFFATeamPanel(ctx, x, panelY, pw, ph, teamId);
      });
    } else if (useSingleRow) {
      drawScorePanel(ctx, sidePad, panelY, panelW, panelH, 'black', state.blackScore);
      drawScorePanel(ctx, W - panelW - sidePad, panelY, panelW, panelH, 'white', state.whiteScore);
    } else {
      drawScorePanel(ctx, sidePad, panelY, panelW, panelH, 'black', state.blackScore);
      drawScorePanel(ctx, W - panelW - sidePad, panelY, panelW, panelH, 'white', state.whiteScore);
    }

    if (state.phase === 'playing') {
      const turnText = getTurnBannerText();
      const fs = Math.max(mobile ? 12 : 13, Math.round(H * (mobile ? 0.024 : 0.019)));
      ctx.font = `bold ${fs}px "Noto Serif SC", SimSun, serif`;
      ctx.textAlign = 'center';
      const bx = turnBarX;
      const barW = turnBarW;

      ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowOffsetY = 1;
      ctx.fillStyle = 'rgba(240,225,185,0.98)';
      roundRect2(ctx, bx, turnBarY, barW, turnBarH, 5);
      ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.strokeStyle = 'rgba(140,90,20,0.85)';
      ctx.lineWidth = 1.5;
      roundRect2(ctx, bx, turnBarY, barW, turnBarH, 5);
      ctx.stroke();

      ctx.fillStyle = '#180A02';
      const textY = turnBarY + turnBarH * 0.64;

      const showTimer = state.subPhase === 'waiting' && isHumanTurn() &&
        (state.timerActive || state.timerPaused);
      const showPause = state.timerPaused && state.peerAway;

      if (showPause) {
        ctx.fillText('对方暂时离开，计时暂停', bx + barW / 2, textY);
      } else if (showTimer) {
        ctx.fillText(`${turnText}  ·  ⏳ ${state.timer}s`, bx + barW / 2, textY);
      } else {
        ctx.fillText(turnText, bx + barW / 2, textY);
      }
    }

    if (!isFourWay()) drawPieceCountIcons(ctx, W, H);
    ctx.restore();
  }

  function drawScorePanel(ctx, x, y, w, h, team, score) {
    ctx.save();
    // 背景阴影
    ctx.shadowBlur = 12;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;
    // 面板底色（米色，与背景有明显区分）
    ctx.fillStyle = 'rgba(245,232,200,0.97)';
    roundRect2(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

    // 金色外边框
    ctx.strokeStyle = 'rgba(160,100,20,0.9)';
    ctx.lineWidth = 2;
    roundRect2(ctx, x, y, w, h, 6);
    ctx.stroke();
    // 内细线
    ctx.strokeStyle = 'rgba(180,130,40,0.4)';
    ctx.lineWidth = 0.8;
    roundRect2(ctx, x + 4, y + 4, w - 8, h - 8, 3);
    ctx.stroke();

    ctx.textAlign = 'center';
    // 队伍标签
    ctx.fillStyle = team === 'black' ? '#0A0402' : '#1A0E04';
    const labelFs = Math.max(10, Math.round(h * 0.21));
    ctx.font = `bold ${labelFs}px "Noto Serif SC", SimSun, serif`;
    ctx.fillText(team === 'black' ? '黑方' : '白方', x + w / 2, y + h * 0.24);

    // 分割线
    ctx.strokeStyle = 'rgba(140,90,20,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 8, y + h * 0.32); ctx.lineTo(x + w - 8, y + h * 0.32); ctx.stroke();

    // 大分数字
    const CN = ['0','1','2','3','4','5','6'];
    ctx.font = `bold ${Math.max(20, Math.round(h * 0.46))}px "Noto Serif SC", SimSun, serif`;
    ctx.fillStyle = team === 'black' ? '#100602' : '#200E04';
    ctx.fillText(CN[Math.min(score, 6)], x + w / 2, y + h * 0.82);
    ctx.restore();
  }

  function drawPauseBanner(ctx, cx, cy) {
    ctx.save();
    ctx.textAlign = 'center';
    const fs = Math.max(12, 14);
    ctx.font = `bold ${fs}px "Noto Serif SC", SimSun, serif`;
    ctx.fillStyle = 'rgba(120, 70, 10, 0.92)';
    ctx.fillText('对方暂时离开，计时暂停', cx, cy);
    ctx.restore();
  }

  function drawTimer(ctx, cx, cy, time, maxTime) {
    const ratio = time / maxTime;
    const isUrgent = ratio < 0.3;
    ctx.save();
    ctx.textAlign = 'center';
    const sz = 12;
    ctx.strokeStyle = isUrgent ? 'rgba(190,50,20,0.8)' : 'rgba(90,55,20,0.7)';
    ctx.lineWidth = 1.5;
    // 沙漏外形
    ctx.beginPath();
    ctx.moveTo(cx - sz, cy - sz * 0.75);
    ctx.lineTo(cx + sz, cy - sz * 0.75);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sz, cy + sz * 0.75);
    ctx.lineTo(cx - sz, cy + sz * 0.75);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.stroke();
    // 流沙
    ctx.fillStyle = isUrgent ? 'rgba(190,50,20,0.35)' : 'rgba(180,140,50,0.35)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const sr = sz * ratio;
    ctx.lineTo(cx + sr, cy + sz * 0.75 * ratio);
    ctx.lineTo(cx - sr, cy + sz * 0.75 * ratio);
    ctx.closePath();
    ctx.fill();

    ctx.font = `${Math.max(12, 14)}px "Noto Serif SC", serif`;
    ctx.fillStyle = isUrgent ? 'rgba(190,50,20,0.9)' : 'rgba(60,40,10,0.8)';
    ctx.fillText(time + 's', cx + sz + 24, cy + 5);
    ctx.restore();
  }

  function drawPieceCountIcons(ctx, W, H) {
    const pieces = Physics.getPieces();
    const bLeft = pieces.filter(p => p.gameTeam === 'black').length;
    const wLeft = pieces.filter(p => p.gameTeam === 'white').length;
    const mobile = isMobileView();
    const R = mobile ? 5 : 6;
    const gap = mobile ? 12 : 15;
    const startY = H - (mobile ? 22 : 30);

    ctx.save();
    for (let i = 0; i < 6; i++) {
      const x = 18 + i * gap;
      ctx.beginPath(); ctx.arc(x, startY, R, 0, Math.PI * 2);
      ctx.fillStyle = i < bLeft ? 'rgba(25,12,2,0.82)' : 'rgba(80,60,40,0.2)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,100,40,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const x = W - 18 - i * gap;
      ctx.beginPath(); ctx.arc(x, startY, R, 0, Math.PI * 2);
      ctx.fillStyle = i < wLeft ? 'rgba(245,240,218,0.9)' : 'rgba(200,190,170,0.2)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,100,40,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
    }
    ctx.restore();
  }

  // ===== 布局 UI =====
  function drawLayoutUI() {
    const ctx = getCtx();
    const W = viewW(), H = viewH();
    const mobile = isMobileView();
    const team = state.layoutTeam;
    const teamLabel = isFourWay() ? Teams.getName(team) : (team === 'black' ? '黑方' : '白方');
    const isAI = isFourWay() ? false : (state.mode === '1P' && team === state.aiTeam);
    if (isAI) return;

    const placed = state.layoutPlaced;
    const fontSize = Math.max(mobile ? 13 : 15, Math.round(H * (mobile ? 0.028 : 0.024)));
    ctx.save();
    ctx.font = `bold ${fontSize}px "Noto Serif SC", SimSun, serif`;
    ctx.textAlign = 'center';

    const msg1 = state.onlineWaitingOpponent
      ? '已确认布局，等待对方…'
      : `${teamLabel}布局  已置 ${placed} / 6${placed === 0 ? '（首枚为主将）' : ''}`;
    const msg2 = isFourWay()
      ? '在屏幕下方区域摆子（首枚为主将，顶标皇冠）'
      : (state.mode === 'ONLINE'
        ? '联机盲布局：对方棋子不可见，请在自己区域摆子'
        : '点击棋盘己方区域放置棋子');
    const hasBtn = placed >= 6 && !state.onlineWaitingOpponent;
    const panelY = mobile ? 8 : 14;
    const panelH = mobile ? 70 : 88;
    const scoreBottom = panelY + panelH;
    const sidePad = mobile ? 8 : 16;
    const bh = hasBtn ? (mobile ? 72 : 80) : (mobile ? 52 : 58);
    const bw = Math.min(Math.max(ctx.measureText(msg1).width + (mobile ? 40 : 60), mobile ? W - 24 : 300), W - sidePad * 2);
    const bx = W / 2 - bw / 2;
    const by = scoreBottom + (mobile ? 6 : 8);

    ctx.shadowBlur = 16; ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowOffsetY = 4;
    ctx.fillStyle = 'rgba(242,228,190,0.97)';
    roundRect2(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    ctx.strokeStyle = 'rgba(140,90,20,0.9)';
    ctx.lineWidth = 2;
    roundRect2(ctx, bx, by, bw, bh, 8);
    ctx.stroke();

    ctx.fillStyle = '#1A0A02';
    ctx.fillText(msg1, W / 2, by + (mobile ? 22 : 24));
    ctx.font = `${Math.max(12, Math.round(H * 0.018))}px "Noto Serif SC", SimSun, serif`;
    ctx.fillStyle = '#4A2A10';
    ctx.fillText(msg2, W / 2, by + (mobile ? 40 : 44));

    if (hasBtn) {
      const btnW = 120, btnH = 32, btnX = W / 2 - btnW / 2, btnY = by + (mobile ? 46 : 50);
      ctx.fillStyle = 'rgba(70,32,8,0.88)';
      roundRect2(ctx, btnX, btnY, btnW, btnH, 5);
      ctx.fill();
      ctx.fillStyle = '#E8D880';
      ctx.font = `bold ${Math.max(13, Math.round(H * 0.019))}px "Noto Serif SC", serif`;
      ctx.fillText('确认布局', W / 2, btnY + 21);
      state._confirmBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };
    } else {
      state._confirmBtnRect = null;
    }
    ctx.restore();
  }

  // ===== 连击提示 =====
  function showComboPrompt() {
    state.subPhase = 'combo';
    state._comboTimer = 4;
    clearInterval(state._comboInterval);
    state._comboInterval = setInterval(() => {
      state._comboTimer--;
      if (state._comboTimer <= 0) skipCombo();
    }, 1000);
  }

  function drawComboPrompt() {
    const ctx = getCtx();
    const W = viewW(), H = viewH();
    const mobile = isMobileView();
    const t = state._comboTimer;
    const bw = mobile ? Math.min(W - 24, 300) : 310;
    const bh = mobile ? 88 : 96;
    const bx = W / 2 - bw / 2, by = H / 2 - bh / 2 - 30;
    ctx.save();

    // 背景
    ctx.fillStyle = 'rgba(248,238,215,0.96)';
    roundRect2(ctx, bx, by, bw, bh, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,140,40,0.8)';
    ctx.lineWidth = 2;
    roundRect2(ctx, bx, by, bw, bh, 8);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#2A1A0A';
    ctx.font = `bold ${Math.round(H * 0.026)}px "Noto Serif SC", serif`;
    ctx.fillText('已击中！', W / 2, by + 30);
    ctx.font = `${Math.round(H * 0.017)}px "Noto Serif SC", serif`;
    ctx.fillStyle = '#5A3A20';
    ctx.fillText(`可再弹一次（${t} 秒后自动跳过）`, W / 2, by + 52);

    const gap = 14, buw = 112, buh = 30;
    const b1x = W / 2 - buw - gap / 2, b2x = W / 2 + gap / 2, bty = by + 60;

    ctx.fillStyle = 'rgba(70,32,8,0.88)';
    roundRect2(ctx, b1x, bty, buw, buh, 5);
    ctx.fill();
    ctx.fillStyle = '#E8D880';
    ctx.font = `bold ${Math.round(H * 0.018)}px "Noto Serif SC", serif`;
    ctx.fillText('再弹一次', b1x + buw / 2, bty + 20);

    ctx.fillStyle = 'rgba(110,90,60,0.6)';
    roundRect2(ctx, b2x, bty, buw, buh, 5);
    ctx.fill();
    ctx.fillStyle = '#3A2A10';
    ctx.fillText('此回合终', b2x + buw / 2, bty + 20);

    state._comboBtnRects = {
      yes: { x: b1x, y: bty, w: buw, h: buh },
      no:  { x: b2x, y: bty, w: buw, h: buh },
    };
    ctx.restore();
  }

  // ===== 得分提示 =====
  function showScoreFlash(scoringTeam) {
    const el = document.getElementById('score-flash');
    if (!el) return;
    el.textContent = scoringTeam === 'black' ? '黑 得一分' : '白 得一分';
    el.style.color = scoringTeam === 'black' ? '#180A02' : '#F5F0E0';
    el.style.textShadow = '0 2px 8px rgba(0,0,0,0.35)';
    el.classList.remove('hidden', 'show');
    void el.offsetWidth; // reflow
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1600);
  }

  // ===== 结局画面（儒雅水墨版）=====
  function drawGameOver() {
    const ctx = getCtx();
    const W = viewW(), H = viewH();
    const mobile = isMobileView();
    ctx.save();

    // 半透明暗罩
    ctx.fillStyle = 'rgba(60,48,32,0.42)';
    ctx.fillRect(0, 0, W, H);

    // ---- 尺寸与字号（随屏自适应）----
    const pw = Math.max(mobile ? 280 : 320, Math.min(W * 0.92, mobile ? 400 : 440));
    const u  = pw / 440;                       // 缩放基准
    const padX = 40 * u;
    const titleFs = Math.round(46 * u);
    const poemFs  = Math.round(19 * u);
    const poemLH  = Math.round(31 * u);
    const statFs  = Math.round(19 * u);
    const rowH    = Math.round(34 * u);
    const btnH    = Math.round(46 * u);
    const btnFs   = Math.round(18 * u);

    // 诗句分行
    ctx.font = `${poemFs}px "Noto Serif SC", serif`;
    const poemLines = wrapTextLines(ctx, state._endingPoem || '', pw - padX * 2 - 8 * u);

    const rows = [
      ['弹射之数', state.stats.black.shots,    state.stats.white.shots],
      ['命中之数', state.stats.black.hits,     state.stats.white.hits],
      ['连击之最', state.stats.black.maxCombo, state.stats.white.maxCombo],
      ['终局之得', state.blackScore,            state.whiteScore],
    ];

    const killTeams = killStatTeams();
    const hKillToggle = rowH;
    const hKillDetail = state._killStatsExpanded ? rowH + killTeams.length * rowH : 0;
    const gapKill = 14 * u;

    // ---- 计算各区块高度，得到面板总高 ----
    const padTop = 34 * u;
    const hTitle = titleFs;
    const gap1   = 20 * u;
    const hPoem  = poemLines.length * poemLH;
    const gap2   = 22 * u;
    const hDiv   = 1;
    const gap3   = 20 * u;
    const hStatsHead = rowH;
    const hStats = rows.length * rowH;
    const gap4   = 18 * u;
    const hBtns  = btnH;
    const padBot = 32 * u;
    const ph = padTop + hTitle + gap1 + hPoem + gap2 + hDiv + gap3 + hStatsHead + hStats
      + gap4 + hKillToggle + hKillDetail + gapKill + hBtns + padBot;

    const px = W / 2 - pw / 2;
    const py = H / 2 - ph / 2;
    const cx = W / 2;

    // ---- 卷轴面板 ----
    ctx.shadowBlur = 36 * u; ctx.shadowColor = 'rgba(30,20,8,0.4)';
    const panelGrad = ctx.createLinearGradient(px, py, px, py + ph);
    panelGrad.addColorStop(0, '#FBF5E6');
    panelGrad.addColorStop(1, '#F1E7D0');
    ctx.fillStyle = panelGrad;
    roundRect2(ctx, px, py, pw, ph, 14 * u);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 双层描边（淡墨 + 内细线）
    ctx.strokeStyle = 'rgba(120,95,55,0.55)';
    ctx.lineWidth = 1.5 * u;
    roundRect2(ctx, px, py, pw, ph, 14 * u);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,95,55,0.28)';
    ctx.lineWidth = 1 * u;
    roundRect2(ctx, px + 9 * u, py + 9 * u, pw - 18 * u, ph - 18 * u, 9 * u);
    ctx.stroke();

    ctx.textAlign = 'center';
    let y = py + padTop;

    // ---- 胜负标题（描边 + 朱印点缀）----
    const winnerName = isFourWay() ? Teams.getName(state.winner) : (state.winner === 'black' ? '黑方' : '白方');
    y += hTitle * 0.8;
    ctx.font = `bold ${titleFs}px "Noto Serif SC", serif`;
    // 标题主体
    ctx.fillStyle = '#2A1B0C';
    ctx.fillText(`${winnerName}胜矣`, cx, y);
    // 朱红印章「勝」置于标题右上
    const tW = ctx.measureText(`${winnerName}胜矣`).width;
    const sealS = 26 * u;
    const sealX = cx + tW / 2 + sealS * 0.75;
    const sealY = y - titleFs * 0.62;
    ctx.fillStyle = 'rgba(170,52,38,0.92)';
    roundRect2(ctx, sealX - sealS / 2, sealY, sealS, sealS, 4 * u);
    ctx.fill();
    ctx.fillStyle = '#FBF5E6';
    ctx.font = `bold ${Math.round(sealS * 0.62)}px "Noto Serif SC", serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('勝', sealX, sealY + sealS / 2 + 1 * u);
    ctx.textBaseline = 'alphabetic';

    // ---- 寄语诗句 ----
    y += gap1 + poemLH * 0.2;
    ctx.font = `${poemFs}px "Noto Serif SC", serif`;
    ctx.fillStyle = '#6B4A2A';
    poemLines.forEach((line, i) => {
      ctx.fillText(line, cx, y + i * poemLH);
    });
    y += hPoem + gap2;

    // ---- 分隔（细线 + 中心菱形）----
    ctx.strokeStyle = 'rgba(150,118,60,0.4)';
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.moveTo(px + padX, y); ctx.lineTo(cx - 14 * u, y);
    ctx.moveTo(cx + 14 * u, y); ctx.lineTo(px + pw - padX, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(170,52,38,0.7)';
    ctx.save();
    ctx.translate(cx, y); ctx.rotate(Math.PI / 4);
    const d = 4 * u;
    ctx.fillRect(-d, -d, d * 2, d * 2);
    ctx.restore();
    y += gap3;

    // ---- 统计（三列：项 / 黑 / 白）----
    const colL = px + padX + 6 * u;          // 项目左对齐
    const colB = px + pw * 0.6;              // 黑方
    const colWcol = px + pw * 0.82;          // 白方
    ctx.font = `${statFs}px "Noto Serif SC", serif`;
    ctx.textBaseline = 'middle';

    // 表头
    let ry = y + rowH / 2;
    ctx.fillStyle = '#8A6A3A';
    ctx.textAlign = 'left';   ctx.fillText('对弈', colL, ry);
    ctx.textAlign = 'center'; ctx.fillText('黑方', colB, ry);
    ctx.fillText('白方', colWcol, ry);
    y += rowH;

    rows.forEach((row, ri) => {
      ry = y + rowH / 2;
      const isScore = ri === rows.length - 1;
      // 斑马底纹
      if (ri % 2 === 0) {
        ctx.fillStyle = 'rgba(150,118,60,0.06)';
        ctx.fillRect(px + padX * 0.5, y, pw - padX, rowH);
      }
      if (isScore) {
        ctx.fillStyle = 'rgba(170,52,38,0.08)';
        ctx.fillRect(px + padX * 0.5, y, pw - padX, rowH);
      }
      ctx.fillStyle = isScore ? '#A2341E' : '#4A3018';
      ctx.font = `${isScore ? 'bold ' : ''}${statFs}px "Noto Serif SC", serif`;
      ctx.textAlign = 'left';   ctx.fillText(row[0], colL, ry);
      ctx.textAlign = 'center'; ctx.fillText(String(row[1]), colB, ry);
      ctx.fillText(String(row[2]), colWcol, ry);
      y += rowH;
    });
    ctx.textBaseline = 'alphabetic';
    y += gap4;

    // ---- 击杀统计（点击展开/收起）----
    const killBarX = px + padX * 0.5;
    const killBarW = pw - padX;
    const killToggleY = y;
    ctx.fillStyle = state._killStatsExpanded ? 'rgba(170,52,38,0.1)' : 'rgba(150,118,60,0.08)';
    roundRect2(ctx, killBarX, killToggleY, killBarW, hKillToggle, 6 * u);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,90,20,0.45)';
    ctx.lineWidth = 1 * u;
    roundRect2(ctx, killBarX, killToggleY, killBarW, hKillToggle, 6 * u);
    ctx.stroke();

    const totalKills = killTeams.reduce((sum, t) => sum + (state.stats[t]?.kills || 0), 0);
    const toggleLabel = state._killStatsExpanded
      ? `击杀统计  ·  点击收起  ▲  （共 ${totalKills}）`
      : `击杀统计  ·  点击展开  ▼  （共 ${totalKills}）`;
    ctx.font = `${statFs}px "Noto Serif SC", serif`;
    ctx.fillStyle = '#4A3018';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(toggleLabel, cx, killToggleY + hKillToggle / 2);
    ctx.textBaseline = 'alphabetic';
    state._killStatsToggleRect = { x: killBarX, y: killToggleY, w: killBarW, h: hKillToggle };
    y += hKillToggle;

    if (state._killStatsExpanded) {
      const colStart = px + padX + 4 * u;
      const colW = (pw - padX * 2 - 8 * u) / (killTeams.length + 2);
      ry = y + rowH / 2;
      ctx.font = `bold ${Math.round(statFs * 0.88)}px "Noto Serif SC", serif`;
      ctx.fillStyle = '#8A6A3A';
      ctx.textAlign = 'left';
      ctx.fillText('击杀方', colStart, ry);
      killTeams.forEach((vt, i) => {
        const shortName = isFourWay() ? Teams.getName(vt).charAt(0) : (vt === 'black' ? '黑' : '白');
        ctx.textAlign = 'center';
        ctx.fillText(shortName, colStart + colW * (i + 1.2), ry);
      });
      ctx.textAlign = 'center';
      ctx.fillText('计', colStart + colW * (killTeams.length + 1.5), ry);
      y += rowH;

      killTeams.forEach((kt, ri) => {
        ry = y + rowH / 2;
        if (ri % 2 === 0) {
          ctx.fillStyle = 'rgba(150,118,60,0.06)';
          ctx.fillRect(killBarX, y, killBarW, rowH);
        }
        ensureStatTeam(kt);
        const kbv = state.stats[kt].killByVictim || {};
        const total = state.stats[kt].kills || 0;
        ctx.fillStyle = kt === state.winner ? '#A2341E' : '#4A3018';
        ctx.font = `${statFs}px "Noto Serif SC", serif`;
        ctx.textAlign = 'left';
        const kName = isFourWay() ? Teams.getName(kt) : (kt === 'black' ? '黑方' : '白方');
        ctx.fillText(kName, colStart, ry);
        killTeams.forEach((vt, i) => {
          const n = kt === vt ? '—' : String(kbv[vt] || 0);
          ctx.textAlign = 'center';
          ctx.fillStyle = kt === vt ? '#999' : ((kbv[vt] || 0) > 0 ? '#4A3018' : '#aaa');
          ctx.fillText(n, colStart + colW * (i + 1.2), ry);
        });
        ctx.textAlign = 'center';
        ctx.fillStyle = total > 0 ? '#A2341E' : '#888';
        ctx.fillText(String(total), colStart + colW * (killTeams.length + 1.5), ry);
        y += rowH;
      });
    }
    y += gapKill;

    // ---- 按钮（两枚）----
    const bgap = 16 * u;
    const btnW = (pw - padX * 2 - bgap) / 2;
    const b1x = px + padX;
    const b2x = b1x + btnW + bgap;
    const btnY = y;

    const buttons = [
      { x: b1x, label: '再弈一局', primary: true },
      { x: b2x, label: '归隐',     primary: false },
    ];
    ctx.textBaseline = 'middle';
    buttons.forEach(b => {
      if (b.primary) {
        const g = ctx.createLinearGradient(b.x, btnY, b.x, btnY + btnH);
        g.addColorStop(0, '#7A3A18');
        g.addColorStop(1, '#5E2C10');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(252,245,230,0.7)';
      }
      roundRect2(ctx, b.x, btnY, btnW, btnH, 9 * u);
      ctx.fill();
      ctx.strokeStyle = b.primary ? 'rgba(120,80,40,0.9)' : 'rgba(140,110,60,0.5)';
      ctx.lineWidth = 1.3 * u;
      roundRect2(ctx, b.x, btnY, btnW, btnH, 9 * u);
      ctx.stroke();
      ctx.fillStyle = b.primary ? '#F4E6BE' : '#5A3A1E';
      ctx.font = `${b.primary ? 'bold ' : ''}${btnFs}px "Noto Serif SC", serif`;
      ctx.textAlign = 'center';
      ctx.fillText(b.label, b.x + btnW / 2, btnY + btnH / 2 + 1 * u);
    });
    ctx.textBaseline = 'alphabetic';

    state._gameoverBtns = {
      restart: { x: b1x, y: btnY, w: btnW, h: btnH },
      menu:    { x: b2x, y: btnY, w: btnW, h: btnH },
    };

    ctx.restore();
  }

  // 将文本按最大宽度切分为多行（返回行数组）
  function wrapTextLines(ctx, text, maxW) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        lines.push(cur); cur = ch;
      } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function wrapText(ctx, text, cx, y, maxW, lineH) {
    const words = [];
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW) {
        words.push(cur); cur = ch;
      } else cur += ch;
    }
    if (cur) words.push(cur);
    words.forEach((w, i) => ctx.fillText(w, cx, y + i * lineH));
  }

  // ===== Canvas 点击路由（接收屏幕坐标）=====
  function handleCanvasClick(sx, sy) {
    // 布局确认
    if (state.phase === 'layout' && state._confirmBtnRect) {
      const b = state._confirmBtnRect;
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) {
        Audio.uiClick();
        confirmLayout();
        return;
      }
    }
    // 连击按钮
    if (state.subPhase === 'combo' && state._comboBtnRects) {
      const { yes, no } = state._comboBtnRects;
      if (sx >= yes.x && sx <= yes.x + yes.w && sy >= yes.y && sy <= yes.y + yes.h) {
        Audio.uiClick(); acceptCombo(); return;
      }
      if (sx >= no.x && sx <= no.x + no.w && sy >= no.y && sy <= no.y + no.h) {
        Audio.uiClick(); skipCombo(); return;
      }
    }
    // 结局按钮
    if (state.phase === 'gameover') {
      if (state._killStatsToggleRect) {
        const r = state._killStatsToggleRect;
        if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
          Audio.uiClick();
          state._killStatsExpanded = !state._killStatsExpanded;
          return;
        }
      }
      if (state._gameoverBtns) {
      const { restart, menu } = state._gameoverBtns;
      if (sx >= restart.x && sx <= restart.x + restart.w && sy >= restart.y && sy <= restart.y + restart.h) {
        Audio.uiClick(); showModeSelect(); return;
      }
      if (sx >= menu.x && sx <= menu.x + menu.w && sy >= menu.y && sy <= menu.y + menu.h) {
        Audio.uiClick(); showMainMenu(); return;
      }
      }
    }
  }

  // ===== DOM 屏幕控制 =====
  function showScreen(id) {
    if (state._visibleScreen === id) {
      if (id === 'game-screen') updateOnlineGameControls();
      return;
    }
    state._visibleScreen = id;
    ['main-menu', 'mode-select', 'online-lobby', 'game-screen', 'culture-screen', 'settings-screen']
      .forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.add('hidden');
      });
    const t = document.getElementById(id);
    if (t) t.classList.remove('hidden');
    if (id === 'game-screen') updateOnlineGameControls();
    else {
      document.getElementById('online-game-controls')?.classList.add('hidden');
      document.getElementById('sp-game-controls')?.classList.add('hidden');
    }
  }

  function temporaryLeaveOnline() {
    if (state.mode !== 'ONLINE') return;
    if (!confirm('暂时离开？对局将暂停计时，10 分钟内可回到本局。\n\n若要开新房间，请到大厅点「创建房间」（会结束当前对局）。')) return;
    Online.markInMatch(true);
    persistLocalMatch();
    if (state.onlineRole === 'host' && state.phase === 'playing' && state.subPhase === 'waiting') {
      pauseGameTimer(true);
    }
    Online.quitGame();
    Audio.stopAmbient();
    updateOnlineGameControls();
    showScreen('main-menu');
    alert('已暂时离开。10 分钟内可点「回到对局」或刷新页面恢复；若要新建房间，请进联机大厅点「创建房间」。');
  }

  function quitSinglePlayerMatch() {
    if (state.mode !== '1P') return;
    if (!confirm('确定退出对局？')) return;
    clearInterval(state._timerInterval);
    clearInterval(state._comboInterval);
    Input.disablePlacement();
    state.phase = 'menu';
    state.movingPiece = null;
    state.selectedPiece = null;
    Audio.stopAmbient();
    updateOnlineGameControls();
    showScreen('main-menu');
  }

  function quitOnlineMatchFull() {
    if (state.mode !== 'ONLINE') return;
    if (!confirm('确定退出对局？退出后无法恢复当前棋局。')) return;
    clearInterval(state._timerInterval);
    clearInterval(state._comboInterval);
    Online.markInMatch(false);
    clearLocalMatch();
    Online.leave();
    resetOnlineMatchState();
    state.mode = '2P';
    state.phase = 'menu';
    Audio.stopAmbient();
    updateOnlineGameControls();
    showScreen('main-menu');
  }

  function onOnlineResumed() {
    if (!Online.isInMatch()) return;
    state.mode = 'ONLINE';
    state.onlineRole = Online.getRole();
    state.onlineMyTeam = state.onlineRole === 'host' ? 'black' : 'white';
    state._stateSeq = 0;
    state._lastMotionSeq = 0;
    restoreLocalMatch();
    if (state._visibleScreen !== 'game-screen') {
      showScreen('game-screen');
    }
    window._matchUIEntered = true;
    updateOnlineGameControls();
    Online.requestGameStart();
  }

  function showMainMenu(skipOnlineDisconnect) {
    clearInterval(state._timerInterval);
    clearInterval(state._comboInterval);
    if (!skipOnlineDisconnect && state.mode === 'ONLINE' && Online.isConnected()) {
      Online.markInMatch(false);
      clearLocalMatch();
      Online.leave();
    }
    state.phase = 'menu';
    resetOnlineMatchState();
    Audio.stopAmbient();
    updateOnlineGameControls();
    showScreen('main-menu');
  }

  function showModeSelect() {
    showScreen('mode-select');
  }

  // 注册 mouseup / touchend 处理 HUD 按钮（mousedown 会 preventDefault 阻止 click）
  function initCanvasClickHandler(c) {
    c.addEventListener('mouseup', e => {
      const rect = c.getBoundingClientRect();
      handleCanvasClick(e.clientX - rect.left, e.clientY - rect.top);
    });
    c.addEventListener('touchend', e => {
      if (!e.changedTouches.length) return;
      const rect = c.getBoundingClientRect();
      const t = e.changedTouches[0];
      handleCanvasClick(t.clientX - rect.left, t.clientY - rect.top);
    }, { passive: true });
  }

  return {
    state,
    init,
    update,
    render,
    startGame,
    startFourWayGame,
    confirmLayout,
    acceptCombo,
    skipCombo,
    showMainMenu,
    showModeSelect,
    showScreen,
    initCanvasClickHandler,
    onOnlineMessage,
    onServerGameState,
    onServerGameMotion,
    onMatchReady,
    hostStartOnlineMatch,
    onPeerJoinedOnline,
    onGuestJoinedOnline,
    onOnlineResumed,
    temporaryLeaveOnline,
    quitOnlineMatchFull,
    quitSinglePlayerMatch,
    resetOnlineMatchState,
    resetOnlineSyncSeq,
  };
})();
