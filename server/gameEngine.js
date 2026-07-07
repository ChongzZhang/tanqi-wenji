'use strict';

const fs = require('fs');
const path = require('path');
const { createPhysicsEngine, W } = require('./physicsEngine');

const TICK_MS = 1000 / 60;
const TIMER_MAX = 30;
const WIN_SCORE = 6;
const MOTION_BROADCAST_MS = 20; // 约 50Hz 下发；物理仍 60fps
const DEBUG_LOG = path.join(__dirname, '..', '..', '.cursor', 'debug-7e2651.log');
/** @type {Map<string, ServerGame>} */
const games = new Map();

function teamForSeat(seat) {
  return seat === 'host' ? 'black' : 'white';
}

function generateFunItems(physics, obstaclePositions) {
  const occupied = (obstaclePositions || []).map((p) => ({ x: p.x, y: p.y, r: 40 }));
  const farEnough = (x, y, r) =>
    Math.hypot(x - W.centerX, y - W.centerY) > W.domeRadius + r + 10 &&
    occupied.every((o) => Math.hypot(o.x - x, o.y - y) > o.r + r);

  const perimeter = W.boardSize * 4;
  const targetWallLen = perimeter / 3;
  const inset = 7;
  const edges = [
    { horizontal: true, fixed: W.boardTop + inset },
    { horizontal: true, fixed: W.boardBottom - inset },
    { horizontal: false, fixed: W.boardLeft + inset },
    { horizontal: false, fixed: W.boardRight - inset },
  ];
  let wallTotal = 0;
  let guard = 0;
  while (wallTotal < targetWallLen && guard++ < 30) {
    const e = edges[Math.floor(Math.random() * edges.length)];
    const len = 70 + Math.random() * 110;
    const lo = (e.horizontal ? W.boardLeft : W.boardTop) + len / 2 + 6;
    const hi = (e.horizontal ? W.boardRight : W.boardBottom) - len / 2 - 6;
    const c = lo + Math.random() * (hi - lo);
    const x = e.horizontal ? c : e.fixed;
    const y = e.horizontal ? e.fixed : c;
    physics.createWall(x, y, len, e.horizontal);
    wallTotal += len;
  }

  const blockCount = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < blockCount; i++) {
    for (let t = 0; t < 50; t++) {
      const x = W.centerX + (Math.random() - 0.5) * 320;
      const y = W.centerY + (Math.random() - 0.5) * 240;
      if (farEnough(x, y, 30)) {
        physics.createBlock(x, y);
        occupied.push({ x, y, r: 30 });
        break;
      }
    }
  }

  const holeR = W.pieceRadius * 2;
  for (let i = 0; i < 2; i++) {
    for (let t = 0; t < 60; t++) {
      const x = W.boardLeft + 50 + Math.random() * (W.boardSize - 100);
      const y = W.centerY + (Math.random() - 0.5) * 30;
      if (farEnough(x, y, holeR + 6)) {
        physics.addHole(x, y, holeR);
        occupied.push({ x, y, r: holeR + 20 });
        break;
      }
    }
  }
}

function setupRandomBoard(physics) {
  const obsCount = 1 + Math.floor(Math.random() * 3);
  const placed = [];
  for (let i = 0; i < obsCount; i++) {
    let ox;
    let oy;
    let tries = 0;
    do {
      ox = W.centerX + (Math.random() - 0.5) * 240;
      oy = W.centerY + (Math.random() - 0.5) * 180;
      tries++;
    } while (tries < 60 && (
      Math.hypot(ox - W.centerX, oy - W.centerY) < W.domeRadius + 35 ||
      placed.some((p) => Math.hypot(p.x - ox, p.y - oy) < 65)
    ));
    physics.createObstacle(ox, oy);
    placed.push({ x: ox, y: oy });
  }
  generateFunItems(physics, placed);
  return placed;
}

function tagSpecials(physics) {
  const pcs = physics.getPieces();
  pcs.forEach((p) => { p.special = null; });
  for (const team of ['black', 'white']) {
    const teamPcs = pcs.filter((p) => p.gameTeam === team);
    if (teamPcs.length >= 2) teamPcs[teamPcs.length - 2].special = 'curve';
    if (teamPcs.length >= 6) teamPcs[teamPcs.length - 1].special = 'speed';
  }
}

class ServerGame {
  /**
   * @param {string} roomCode
   * @param {(msg: object) => void} broadcast
   */
  constructor(roomCode, broadcast) {
    this.code = roomCode;
    this.broadcast = broadcast;
    this.physics = createPhysicsEngine();
    this.phase = 'idle';
    this.subPhase = 'waiting';
    this.currentTurn = 'black';
    this.blackScore = 0;
    this.whiteScore = 0;
    this.winner = null;
    this.timer = TIMER_MAX;
    this.timerPaused = false;
    this.peerAway = false;
    this.layoutConfirmed = { black: false, white: false };
    this.layouts = { black: null, white: null };
    this.board = null;
    this.hitThisTurn = false;
    this.scoredThisTurn = false;
    this.stats = {
      black: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
      white: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
    };
    this.seq = 0;
    this._stillFrames = 0;
    this._moveStart = 0;
    this._timerAcc = 0;
    this._movingPieceKey = null;
    this._lastBroadcast = 0;
    this._lastMotionDebugT = 0;
    this._lastMotionDebugLogAt = 0;
    this._fxEvents = [];
    this._lastMotionCompact = null;

    this.physics.onCollision((pos, vel, bodyA, bodyB) => {
      if (this.phase !== 'playing' || this.subPhase !== 'moving') return;
      const intensity = Math.min(vel / 15, 1);
      this._fxEvents.push([
        'p',
        Math.round(pos.x * 10) / 10,
        Math.round(pos.y * 10) / 10,
        Math.round(intensity * 100) / 100,
      ]);
      if (bodyA.gameTeam && bodyB.gameTeam && bodyA.gameTeam !== bodyB.gameTeam) {
        this.hitThisTurn = true;
        this.stats[this.currentTurn].hits++;
      }
    });

    this.physics.onWallHit((pos, vel, kind) => {
      if (this.phase !== 'playing' || this.subPhase !== 'moving') return;
      const intensity = Math.min(vel / 15, 1);
      this._fxEvents.push([
        kind === 'block' ? 'b' : 'w',
        Math.round(pos.x * 10) / 10,
        Math.round(pos.y * 10) / 10,
        Math.round(intensity * 0.7 * 100) / 100,
      ]);
    });

    this.physics.onOutOfBounds((body) => this.handlePieceFall(body));
  }

  exportState(opts = {}) {
    const full = !!opts.full;
    const includeBoard = full || !!opts.includeBoard || this.phase === 'layout';
    const st = {
      phase: this.phase,
      subPhase: this.subPhase,
      currentTurn: this.currentTurn,
      blackScore: this.blackScore,
      whiteScore: this.whiteScore,
      winner: this.winner,
      timer: this.timer,
      timerMax: TIMER_MAX,
      timerPaused: this.timerPaused,
      peerAway: this.peerAway,
      layoutConfirmed: { ...this.layoutConfirmed },
      movingPiece: this._movingPieceKey,
    };
    if (includeBoard) st.board = this.board;
    if (!opts.timerOnly && (full || this.phase !== 'layout')) {
      st.pieces = this.physics.exportPiecesCompact();
    }
    return st;
  }

  exportMotion() {
    const all = this.physics.exportPiecesCompact();
    const movingKey = this._movingPieceKey;
    let pieces = all;
    let partial = false;

    if (this._lastMotionCompact) {
      const lastMap = {};
      for (const row of this._lastMotionCompact) {
        lastMap[`${row[0]}:${row[1]}`] = row;
      }
      const delta = [];
      for (const row of all) {
        const key = `${row[0]}:${row[1]}`;
        const last = lastMap[key];
        const isMoving = key === movingKey;
        const hasVel = Math.abs(row[4]) > 0.005 || Math.abs(row[5]) > 0.005;
        const changed = !last ||
          Math.abs(last[2] - row[2]) > 0.005 || Math.abs(last[3] - row[3]) > 0.005 ||
          Math.abs(last[4] - row[4]) > 0.005 || Math.abs(last[5] - row[5]) > 0.005;
        if (isMoving || hasVel || changed) delta.push(row);
      }
      if (delta.length > 0 && delta.length < all.length * 0.85) {
        pieces = delta;
        partial = true;
      }
    }
    this._lastMotionCompact = all;

    const motion = {
      subPhase: this.subPhase,
      movingPiece: this._movingPieceKey,
      pieces,
      partial,
    };
    if (this._fxEvents.length) {
      motion.fx = this._fxEvents;
      this._fxEvents = [];
    }
    return motion;
  }

  broadcastState(force = false, opts = {}) {
    const now = Date.now();
    const moving = this.phase === 'playing' && this.subPhase === 'moving';
    if (!force && now - this._lastBroadcast < (moving ? MOTION_BROADCAST_MS : 200)) return;
    this._lastBroadcast = now;
    this.seq++;
    if (moving && !force) {
      const motion = this.exportMotion();
      const dt = this._lastMotionDebugT ? now - this._lastMotionDebugT : 0;
      this._lastMotionDebugT = now;
      // #region agent log
      if (!this._lastMotionDebugLogAt || now - this._lastMotionDebugLogAt >= 400) {
        this._lastMotionDebugLogAt = now;
        try {
          const line = JSON.stringify({
            sessionId: '7e2651', hypothesisId: 'H4', location: 'gameEngine.js:broadcastState',
            message: 'motion broadcast', runId: 'server',
            data: { dt, seq: this.seq, partial: motion.partial, pktPieces: motion.pieces.length },
            timestamp: now,
          });
          fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
          fs.appendFileSync(DEBUG_LOG, line + '\n');
        } catch { /* ignore */ }
      }
      // #endregion
      this.broadcast({
        type: 'game_motion',
        seq: this.seq,
        t: now,
        motion,
      });
      return;
    }
    this.broadcast({
      type: 'game_state',
      seq: this.seq,
      t: now,
      full: !!force,
      state: this.exportState({ full: force, timerOnly: !!opts.timerOnly }),
    });
  }

  startMatch() {
    this.physics.reset();
    setupRandomBoard(this.physics);
    this.board = this.physics.exportBoard();
    this.phase = 'layout';
    this.subPhase = 'waiting';
    this.currentTurn = 'black';
    this.blackScore = 0;
    this.whiteScore = 0;
    this.winner = null;
    this.timer = TIMER_MAX;
    this.timerPaused = false;
    this.peerAway = false;
    this.layoutConfirmed = { black: false, white: false };
    this.layouts = { black: null, white: null };
    this.hitThisTurn = false;
    this.scoredThisTurn = false;
    this.stats = {
      black: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
      white: { shots: 0, hits: 0, maxCombo: 0, combo: 0 },
    };
    this._lastMotionCompact = null;
    this.broadcastState(true);
  }

  setPeerAway(away) {
    this.peerAway = !!away;
    this.timerPaused = this.peerAway;
    this.broadcastState(true);
  }

  teamForClient(clientId, room) {
    const m = room.members.get(clientId);
    if (!m) return null;
    return teamForSeat(m.seat);
  }

  handleAction(clientId, room, action) {
    if (!action || !action.type) return;
    const team = this.teamForClient(clientId, room);
    if (!team) return;

    switch (action.type) {
      case 'layout_done':
        this.onLayoutDone(team, action.pieces);
        break;
      case 'fling':
        this.onFling(team, action);
        break;
      default:
        break;
    }
  }

  onLayoutDone(team, pieces) {
    if (this.phase !== 'layout') return;
    if (!Array.isArray(pieces) || pieces.length !== 6) return;
    if (this.layoutConfirmed[team]) return;
    this.layouts[team] = pieces;
    this.layoutConfirmed[team] = true;
    if (this.layoutConfirmed.black && this.layoutConfirmed.white) {
      this.beginPlaying();
    } else {
      this.broadcastState(true);
    }
  }

  beginPlaying() {
    this.physics.getPieces().slice().forEach((p) => this.physics.removePiece(p));
    this.layouts.black.forEach((p, i) => this.physics.createPiece(p.x, p.y, 'black', i));
    this.layouts.white.forEach((p, i) => this.physics.createPiece(p.x, p.y, 'white', i));
    tagSpecials(this.physics);
    this.phase = 'playing';
    this.subPhase = 'waiting';
    this.currentTurn = 'black';
    this.timer = TIMER_MAX;
    this.timerPaused = this.peerAway;
    this._timerAcc = 0;
    this._lastMotionCompact = null;
    this.broadcastState(true);
  }

  onFling(team, action) {
    if (this.phase !== 'playing' || this.subPhase !== 'waiting') return;
    if (this.currentTurn !== team) return;
    if (this.timerPaused) return;
    const piece = this.physics.getPieces().find(
      (p) => p.gameTeam === action.team && p.slot === action.slot
    );
    if (!piece || piece.gameTeam !== team) return;
    this.stats[team].shots++;
    this.hitThisTurn = false;
    this.scoredThisTurn = false;
    this.subPhase = 'moving';
    this._movingPieceKey = `${piece.gameTeam}:${piece.slot}`;
    this._stillFrames = 0;
    this._moveStart = Date.now();
    this._lastMotionCompact = null;
    this.physics.flingPiece(piece, action.fx, action.fy);
    this.broadcastState(true);
    const now = Date.now();
    this._lastBroadcast = now;
    this.seq++;
    const motion = this.exportMotion();
  // #region agent log
    try {
      const line = JSON.stringify({
        sessionId: '7e2651', hypothesisId: 'H8', location: 'gameEngine.js:onFling',
        message: 'immediate motion after fling', runId: 'server',
        data: { seq: this.seq, pktPieces: motion.pieces.length, partial: motion.partial },
        timestamp: now,
      });
      fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
      fs.appendFileSync(DEBUG_LOG, line + '\n');
    } catch { /* ignore */ }
  // #endregion
    this.broadcast({
      type: 'game_motion',
      seq: this.seq,
      t: now,
      motion,
    });
  }

  handlePieceFall(body) {
    if (!this.physics.getPieces().includes(body)) return;
    if (this.phase !== 'playing') return;
    const fallenTeam = body.gameTeam;
    if (fallenTeam === 'black') this.whiteScore++;
    else this.blackScore++;
    if (fallenTeam !== this.currentTurn) this.scoredThisTurn = true;
    this.physics.removePiece(body);
    if (this.blackScore >= WIN_SCORE) {
      this.declareWinner('black');
      return;
    }
    if (this.whiteScore >= WIN_SCORE) {
      this.declareWinner('white');
      return;
    }
    const remaining = this.physics.getPieces().filter((p) => p.gameTeam === this.currentTurn);
    if (remaining.length === 0) {
      this.declareWinner(this.currentTurn === 'black' ? 'white' : 'black');
      return;
    }
    this.broadcastState(true);
  }

  declareWinner(team) {
    this.phase = 'gameover';
    this.subPhase = 'waiting';
    this.winner = team;
    this.physics.settleAll();
    this._movingPieceKey = null;
    this.broadcastState(true);
  }

  nextTurn() {
    this.subPhase = 'waiting';
    this.hitThisTurn = false;
    this.currentTurn = this.currentTurn === 'black' ? 'white' : 'black';
    this.timer = TIMER_MAX;
    this._timerAcc = 0;
    this._movingPieceKey = null;
  }

  onPiecesStopped() {
    this.physics.settleAll();
    this._stillFrames = 0;
    this._movingPieceKey = null;
    this._lastMotionCompact = null;
    if (this.scoredThisTurn) {
      const s = this.stats[this.currentTurn];
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      this.subPhase = 'waiting';
      this.hitThisTurn = false;
      this.timer = TIMER_MAX;
      this._timerAcc = 0;
    } else {
      this.stats[this.currentTurn].combo = 0;
      this.nextTurn();
    }
    this.broadcastState(true);
  }

  tick(dt) {
    if (this.phase === 'idle' || this.phase === 'gameover') return;

    let changed = false;

    if (this.phase === 'playing') {
      if (this.subPhase === 'moving') {
        this.physics.step(dt);
        if (this.physics.allStopped()) {
          this._stillFrames++;
        } else {
          this._stillFrames = 0;
        }
        const elapsed = Date.now() - this._moveStart;
        if (this._stillFrames >= 6 || elapsed > 5000) {
          this.onPiecesStopped();
          return;
        }
        this.broadcastState(false);
        return;
      }

      if (this.subPhase === 'waiting' && !this.timerPaused) {
        this._timerAcc += dt;
        if (this._timerAcc >= 1000) {
          this._timerAcc -= 1000;
          this.timer--;
          changed = true;
          if (this.timer <= 0) {
            this.nextTurn();
            changed = true;
          }
        }
      }
    }

    if (changed) this.broadcastState(false, { timerOnly: true });
  }
}

let ticker = null;

function ensureTicker() {
  if (ticker) return;
  let last = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(now - last, 50);
    last = now;
    for (const g of games.values()) {
      if (g.phase === 'playing' || g.phase === 'layout') {
        g.tick(dt);
      }
    }
  }, TICK_MS);
}

function getOrCreate(roomCode, broadcast) {
  if (!games.has(roomCode)) {
    games.set(roomCode, new ServerGame(roomCode, broadcast));
    ensureTicker();
  }
  return games.get(roomCode);
}

function destroy(roomCode) {
  games.delete(roomCode);
}

function tryAutoStart(room, broadcast) {
  const online = [...room.members.values()].filter((m) => m.online);
  if (online.length < 2) return null;
  const game = getOrCreate(room.code, (msg) => broadcast(room, msg));
  if (game.phase === 'idle' || game.phase === 'gameover') {
    game.startMatch();
    room.inGame = true;
  } else {
    game.broadcastState(true);
  }
  return game;
}

function handleAction(room, clientId, action, broadcast) {
  if (!action || !action.type) return;
  if (action.type === 'request_start') {
    tryAutoStart(room, broadcast);
    return;
  }
  let game = games.get(room.code);
  if (!game) {
    tryAutoStart(room, broadcast);
    game = games.get(room.code);
  }
  if (!game) return;
  game.handleAction(clientId, room, action);
}

function syncPeerPresence(room) {
  const game = games.get(room.code);
  if (!game || game.phase === 'idle') return;
  const anyOffline = [...room.members.values()].some((m) => !m.online);
  game.setPeerAway(anyOffline);
}

const onPeerAway = syncPeerPresence;

function getFullStateMessage(roomCode) {
  const game = games.get(roomCode);
  if (!game || game.phase === 'idle') return null;
  return {
    type: 'game_state',
    seq: game.seq,
    t: Date.now(),
    state: game.exportState({ full: true, includeBoard: true }),
    full: true,
  };
}

module.exports = {
  tryAutoStart,
  handleAction,
  onPeerAway,
  syncPeerPresence,
  getFullStateMessage,
  destroy,
  getGame: (code) => games.get(code),
};
