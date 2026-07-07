'use strict';

const Matter = require('matter-js');

const W = {
  boardLeft: 60,
  boardTop: 60,
  boardRight: 540,
  boardBottom: 540,
  boardSize: 480,
  centerX: 300,
  centerY: 300,
  domeRadius: 150,
  cornerBulgeRadius: 56,
  pieceRadius: 9,
  obstacleRadius: 18,
  DOME_FORCE_SCALE: 0.0011,
  CORNER_FORCE_SCALE: 0.00008,
  DAMPING: 0.985,
  STOP_SPEED: 0.3,
  REST_SPEED: 0.4,
  FLING_SPEED_SCALE: 260,
};

const CORNER_CENTERS = [
  { x: W.boardLeft + W.cornerBulgeRadius, y: W.boardTop + W.cornerBulgeRadius },
  { x: W.boardRight - W.cornerBulgeRadius, y: W.boardTop + W.cornerBulgeRadius },
  { x: W.boardLeft + W.cornerBulgeRadius, y: W.boardBottom - W.cornerBulgeRadius },
  { x: W.boardRight - W.cornerBulgeRadius, y: W.boardBottom - W.cornerBulgeRadius },
];

const CURVE_FORCE_SCALE = 0.00004;
const SPEED_MULT = 1.5;

function createPhysicsEngine() {
  const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
  const world = engine.world;
  let allPieces = [];
  let obstacles = [];
  let walls = [];
  let blocks = [];
  let holes = [];
  let onCollisionCb = null;
  let onWallHitCb = null;
  let onOutOfBoundsCb = null;

  Matter.Events.on(engine, 'collisionStart', (e) => {
    e.pairs.forEach((pair) => {
      const { bodyA, bodyB } = pair;
      const isPiece = (b) => b.label === 'black' || b.label === 'white' || b.label === 'obstacle';
      const isBarrier = (b) => b.label === 'wall' || b.label === 'block';
      if (isPiece(bodyA) && isPiece(bodyB)) {
        const vel = Math.hypot(bodyA.velocity.x, bodyA.velocity.y);
        if (onCollisionCb) onCollisionCb(bodyA.position, vel, bodyA, bodyB);
      } else if (isBarrier(bodyA) || isBarrier(bodyB)) {
        const piece = isBarrier(bodyA) ? bodyB : bodyA;
        const barrier = isBarrier(bodyA) ? bodyA : bodyB;
        if (piece.label === 'black' || piece.label === 'white' || piece.label === 'obstacle') {
          const vel = Math.hypot(piece.velocity.x, piece.velocity.y);
          if (barrier.label === 'block') piece._blockDamp = true;
          if (onWallHitCb) onWallHitCb(piece.position, vel, barrier.label);
        }
      }
    });
  });

  Matter.Events.on(engine, 'beforeUpdate', () => {
    [...allPieces, ...obstacles].forEach((p) => {
      if (p._blockDamp) {
        Matter.Body.setVelocity(p, { x: p.velocity.x * 0.55, y: p.velocity.y * 0.55 });
        p._blockDamp = false;
      }
      applyFieldForces(p);
    });
  });

  function applyFieldForces(body) {
    if (body.isStatic) return;
    const vel = body.velocity;
    const speed = Math.hypot(vel.x, vel.y);
    if (speed < W.REST_SPEED) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(body, 0);
      body.force.x = 0;
      body.force.y = 0;
      return;
    }
    const pos = body.position;
    {
      const dx = pos.x - W.centerX;
      const dy = pos.y - W.centerY;
      const dist = Math.hypot(dx, dy);
      if (dist < W.domeRadius && dist > 0.5) {
        const slope = 2 * dist / (W.domeRadius * W.domeRadius);
        const fMag = W.DOME_FORCE_SCALE * slope * body.mass;
        Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
      }
    }
    for (const cc of CORNER_CENTERS) {
      const dx = pos.x - cc.x;
      const dy = pos.y - cc.y;
      const dist = Math.hypot(dx, dy);
      if (dist < W.cornerBulgeRadius && dist > 0.5) {
        const slope = 2 * dist / (W.cornerBulgeRadius * W.cornerBulgeRadius);
        const fMag = W.CORNER_FORCE_SCALE * slope * body.mass;
        Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
      }
    }
    if (body.special === 'curve' && speed > W.REST_SPEED) {
      const nx = vel.y / speed;
      const ny = -vel.x / speed;
      const fMag = CURVE_FORCE_SCALE * speed * body.mass;
      Matter.Body.applyForce(body, pos, { x: nx * fMag, y: ny * fMag });
    }
    Matter.Body.setVelocity(body, { x: vel.x * W.DAMPING, y: vel.y * W.DAMPING });
  }

  function isInHole(pos) {
    for (const h of holes) {
      if (Math.hypot(pos.x - h.x, pos.y - h.y) < h.r) return true;
    }
    return false;
  }

  function isOutOfBounds(pos) {
    const margin = 8;
    return (
      pos.x < W.boardLeft - margin ||
      pos.x > W.boardRight + margin ||
      pos.y < W.boardTop - margin ||
      pos.y > W.boardBottom + margin
    );
  }

  function step(delta) {
    const ms = Math.max(0, delta || 1000 / 60);
    const stepSize = 1000 / 60;
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(remaining, stepSize);
      Matter.Engine.update(engine, chunk);
      remaining -= chunk;
    }
    if (onOutOfBoundsCb) {
      const fell = allPieces.filter((p) => isOutOfBounds(p.position) || isInHole(p.position));
      fell.forEach((p) => onOutOfBoundsCb(p));
    }
  }

  function createPiece(wx, wy, team, slot) {
    const body = Matter.Bodies.circle(wx, wy, W.pieceRadius, {
      label: team,
      restitution: 0.72,
      friction: 0.005,
      frictionAir: 0,
      mass: 1.0,
      density: 0.002,
    });
    body.gameTeam = team;
    body.slot = slot != null ? slot : 0;
    Matter.World.add(world, body);
    allPieces.push(body);
    return body;
  }

  function removePiece(body) {
    Matter.World.remove(world, body);
    allPieces = allPieces.filter((b) => b !== body);
  }

  function createObstacle(wx, wy, r) {
    const body = Matter.Bodies.circle(wx, wy, r || W.obstacleRadius, {
      label: 'obstacle',
      restitution: 0.5,
      friction: 0.01,
      frictionAir: 0,
      mass: 2.5,
      density: 0.005,
    });
    Matter.World.add(world, body);
    obstacles.push(body);
    return body;
  }

  function clearObstacles() {
    obstacles.forEach((b) => Matter.World.remove(world, b));
    obstacles = [];
  }

  function createWall(x, y, len, horizontal) {
    const thick = 14;
    const w = horizontal ? len : thick;
    const h = horizontal ? thick : len;
    const body = Matter.Bodies.rectangle(x, y, w, h, {
      label: 'wall',
      isStatic: true,
      restitution: 1.0,
      friction: 0,
    });
    body.wallLen = len;
    body.wallHorizontal = horizontal;
    Matter.World.add(world, body);
    walls.push(body);
    return body;
  }

  function createBlock(x, y, size) {
    const s = size || 26;
    const body = Matter.Bodies.rectangle(x, y, s, s, {
      label: 'block',
      isStatic: true,
      restitution: 0.32,
      friction: 0.2,
      angle: (Math.random() - 0.5) * 0.5,
    });
    body.blockSize = s;
    Matter.World.add(world, body);
    blocks.push(body);
    return body;
  }

  function addHole(x, y, r) {
    holes.push({ x, y, r: r || W.pieceRadius * 2 });
  }

  function clearFunItems() {
    walls.forEach((b) => Matter.World.remove(world, b));
    blocks.forEach((b) => Matter.World.remove(world, b));
    walls = [];
    blocks = [];
    holes = [];
  }

  function flingPiece(body, fx, fy) {
    const mult = body.special === 'speed' ? SPEED_MULT : 1;
    const s = W.FLING_SPEED_SCALE * mult;
    body.force.x = 0;
    body.force.y = 0;
    Matter.Body.setVelocity(body, { x: fx * s, y: fy * s });
    Matter.Body.setAngularVelocity(body, 0);
  }

  function allStopped() {
    return [...allPieces, ...obstacles].every((b) => {
      const v = b.velocity;
      return Math.hypot(v.x, v.y) < W.REST_SPEED + 0.1;
    });
  }

  function settleAll() {
    [...allPieces, ...obstacles].forEach((b) => {
      Matter.Body.setVelocity(b, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(b, 0);
      b.force.x = 0;
      b.force.y = 0;
    });
  }

  function reset() {
    allPieces.forEach((b) => Matter.World.remove(world, b));
    allPieces = [];
    clearObstacles();
    clearFunItems();
  }

  function importBoard(snap) {
    if (!snap) return;
    (snap.obstacles || []).forEach((o) => createObstacle(o.x, o.y));
    (snap.walls || []).forEach((w) => createWall(w.x, w.y, w.len, w.horizontal));
    (snap.blocks || []).forEach((b) => createBlock(b.x, b.y, b.size));
    (snap.holes || []).forEach((h) => addHole(h.x, h.y, h.r));
  }

  function exportBoard() {
    return {
      obstacles: obstacles.map((o) => ({ x: o.position.x, y: o.position.y })),
      walls: walls.map((w) => ({
        x: w.position.x, y: w.position.y, len: w.wallLen, horizontal: w.wallHorizontal,
      })),
      blocks: blocks.map((b) => ({ x: b.position.x, y: b.position.y, size: b.blockSize })),
      holes: holes.map((h) => ({ x: h.x, y: h.y, r: h.r })),
    };
  }

  function exportPieces() {
    return allPieces.map((p) => ({
      team: p.gameTeam,
      slot: p.slot,
      x: p.position.x,
      y: p.position.y,
      vx: p.velocity.x,
      vy: p.velocity.y,
      special: p.special || null,
    }));
  }

  function exportPiecesCompact() {
    return allPieces.map((p) => {
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
    });
  }

  return {
    W,
    step,
    reset,
    createPiece,
    removePiece,
    createObstacle,
    createWall,
    createBlock,
    addHole,
    flingPiece,
    allStopped,
    settleAll,
    importBoard,
    exportBoard,
    exportPieces,
    exportPiecesCompact,
    getPieces: () => allPieces,
    getHoles: () => holes,
    getBlocks: () => blocks,
    onCollision: (cb) => { onCollisionCb = cb; },
    onWallHit: (cb) => { onWallHitCb = cb; },
    onOutOfBounds: (cb) => { onOutOfBoundsCb = cb; },
  };
}

module.exports = { createPhysicsEngine, W };
