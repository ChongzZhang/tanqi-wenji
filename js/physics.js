// 《幽寂弹棋》物理引擎 — Matter.js 封装

const Physics = (() => {
  let engine, runner, world;

  // 世界坐标系：棋盘区域 60-540（共480单位），中心(300,300)
  const W = {
    boardLeft: 60,
    boardTop: 60,
    boardRight: 540,
    boardBottom: 540,
    boardSize: 480,
    centerX: 300,
    centerY: 300,
    domeRadius: 150,          // 丰腹半径（更大范围的隆起）
    cornerBulgeRadius: 56,    // 四角微隆半径
    pieceRadius: 9,
    obstacleRadius: 18,

    // 力场参数
    DOME_FORCE_SCALE: 0.0011,     // 丰腹坡面力度（更强，需大力才能越过中央）
    CORNER_FORCE_SCALE: 0.00008,  // 四角微隆力度
    DAMPING: 0.985,               // 每帧速度衰减系数
    STOP_SPEED: 0.3,              // 低于此速度视为静止
    REST_SPEED: 0.4,             // 低于此速度时静摩擦固定（不再受坡面力，棋子停在斜面）
    FLING_SPEED_SCALE: 260,      // 弹射力 → 初速度 转换系数（最大力也无法从一端直穿对面边界）
  };

  const CORNER_CENTERS = [
    { x: W.boardLeft  + W.cornerBulgeRadius, y: W.boardTop    + W.cornerBulgeRadius },
    { x: W.boardRight - W.cornerBulgeRadius, y: W.boardTop    + W.cornerBulgeRadius },
    { x: W.boardLeft  + W.cornerBulgeRadius, y: W.boardBottom - W.cornerBulgeRadius },
    { x: W.boardRight - W.cornerBulgeRadius, y: W.boardBottom - W.cornerBulgeRadius },
  ];

  let allPieces = [];       // 所有棋子刚体
  let obstacles  = [];      // 障碍物刚体
  let walls      = [];      // 趣味局：反弹墙（高弹静态体）
  let blocks     = [];      // 趣味局：固定阻块（弱反弹静态体）
  let holes      = [];      // 趣味局：陷洞（几何检测，非刚体）{x,y,r}
  let onCollisionCb = null; // 碰撞回调
  let onWallHitCb   = null; // 墙/块碰撞回调
  let outOfBoundsCb = null; // 落盘回调

  // 特殊棋子曲线侧向力度
  const CURVE_FORCE_SCALE = 0.00004;
  const SPEED_MULT = 1.5;          // 疾行棋速度倍率

  function generalMassMult() {
    return (typeof Teams !== 'undefined' && Teams.GENERAL_MASS_MULT) || 2.0;
  }

  function generalFlingMult() {
    return (typeof Teams !== 'undefined' && Teams.GENERAL_FLING_MULT) || 0.52;
  }

  /** 坡面力场按普通棋子质量计算，避免主将因更重而被地形推得更远 */
  function fieldForceMass(body) {
    return body.isGeneral ? 1.0 : body.mass;
  }

  function applyPieceMass(body) {
    if (!body || body.label === 'obstacle') return;
    const m = body.isGeneral ? generalMassMult() : 1.0;
    Matter.Body.setMass(body, m);
    body.friction = body.isGeneral ? 0.014 : 0.005;
    body.frictionAir = body.isGeneral ? 0.014 : 0;
  }

  function flingSpeedScale(body) {
    const speedMult = body.special === 'speed' ? SPEED_MULT : 1;
    const generalMult = body.isGeneral ? generalFlingMult() : 1;
    return W.FLING_SPEED_SCALE * speedMult * generalMult;
  }

  // ---------- 初始化 ----------
  function init() {
    engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
    world  = engine.world;
    runner = Matter.Runner.create({ fps: 60 });

    // 碰撞事件
    Matter.Events.on(engine, 'collisionStart', e => {
      e.pairs.forEach(pair => {
        const { bodyA, bodyB } = pair;
        const isPiece = b => b.gameTeam && (b.label === 'obstacle' || b.label === b.gameTeam);
        const isBarrier = b => b.label === 'wall' || b.label === 'block';
        if (isPiece(bodyA) && isPiece(bodyB)) {
          const vel = Math.hypot(bodyA.velocity.x, bodyA.velocity.y);
          if (onCollisionCb) onCollisionCb(bodyA.position, vel, bodyA, bodyB);
        } else if (isBarrier(bodyA) || isBarrier(bodyB)) {
          const piece = isBarrier(bodyA) ? bodyB : bodyA;
          const barrier = isBarrier(bodyA) ? bodyA : bodyB;
          if (piece.gameTeam || piece.label === 'obstacle') {
            const vel = Math.hypot(piece.velocity.x, piece.velocity.y);
            // 阻块：撞上后能量被削弱（下一帧对反弹后速度做衰减）
            if (barrier.label === 'block') piece._blockDamp = true;
            if (onWallHitCb) onWallHitCb(piece.position, vel, barrier.label);
          }
        }
      });
    });

    // 每帧更新前施加自定义力
    Matter.Events.on(engine, 'beforeUpdate', () => {
      [...allPieces, ...obstacles].forEach(p => {
        // 阻块反弹后削弱能量（在上一帧已完成反弹解算的速度上衰减）
        if (p._blockDamp) {
          Matter.Body.setVelocity(p, { x: p.velocity.x * 0.55, y: p.velocity.y * 0.55 });
          p._blockDamp = false;
        }
        applyFieldForces(p);
      });
    });

    // 让 runner 驱动 engine（不用 Matter.Runner.run，改为手动步进以便我们控制）
    // 实际上每帧由 game.js 调用 step()
  }

  // 丰腹与四角微隆力场
  function applyFieldForces(body) {
    if (body.isStatic) return;

    const vel = body.velocity;
    const speed = Math.hypot(vel.x, vel.y);

    // 静摩擦：速度极低时直接固定，不再受坡面力推动。
    // 这模拟棋子停在斜面上（静摩擦克服坡度），并确保物理能收敛、回合可正常结束。
    if (speed < W.REST_SPEED) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(body, 0);
      body.force.x = 0;
      body.force.y = 0;
      return;
    }

    const pos = body.position;

    // 丰腹（中央隆起）：施加径向外推力
    {
      const dx = pos.x - W.centerX;
      const dy = pos.y - W.centerY;
      const dist = Math.hypot(dx, dy);
      if (dist < W.domeRadius && dist > 0.5) {
        const slope = 2 * dist / (W.domeRadius * W.domeRadius);
        const fMag = W.DOME_FORCE_SCALE * slope * fieldForceMass(body);
        Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
      }
    }

    // 四角微隆
    for (const cc of CORNER_CENTERS) {
      const dx = pos.x - cc.x;
      const dy = pos.y - cc.y;
      const dist = Math.hypot(dx, dy);
      if (dist < W.cornerBulgeRadius && dist > 0.5) {
        const slope = 2 * dist / (W.cornerBulgeRadius * W.cornerBulgeRadius);
        const fMag = W.CORNER_FORCE_SCALE * slope * fieldForceMass(body);
        Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
      }
    }

    // 曲线棋（倒二枚）：施加垂直于速度方向的侧向力，使其走弧线，且只向左偏
    if (body.special === 'curve' && speed > W.REST_SPEED) {
      // 速度方向 (vx,vy) 的「左侧」法向量（世界 y 向下：左转法向为 (vy,-vx)）
      const nx = vel.y / speed;
      const ny = -vel.x / speed;
      const fMag = CURVE_FORCE_SCALE * speed * fieldForceMass(body);
      Matter.Body.applyForce(body, pos, { x: nx * fMag, y: ny * fMag });
    }

    // 滚动衰减（模拟光滑表面摩擦）
    Matter.Body.setVelocity(body, {
      x: vel.x * W.DAMPING,
      y: vel.y * W.DAMPING,
    });
  }

  // ---------- 步进物理（每帧调用）----------
  function step(delta) {
    Matter.Engine.update(engine, delta || 1000 / 60);

    if (outOfBoundsCb) {
      const fell = allPieces.filter(p =>
        isOutOfBounds(p.position) || isInHole(p.position)
      );
      fell.forEach(p => outOfBoundsCb(p));
    }
  }

  /** 联机：在两次服务端同步之间，仅用速度外推位置（不跑 Matter 碰撞） */
  function extrapolatePositions(dt) {
    extrapolateWithDamping(dt);
  }

  /** 带阻尼的外推，更接近服务端衰减，用于帧间补间 */
  function extrapolateWithDamping(dt) {
    const s = Math.min(dt, 0.1);
    const steps = Math.max(1, Math.round(s * 60));
    const subDt = s / steps;
    const dampPerStep = Math.pow(W.DAMPING, subDt * 60);
    for (let step = 0; step < steps; step++) {
      allPieces.forEach((body) => {
        let vx = body.velocity.x * dampPerStep;
        let vy = body.velocity.y * dampPerStep;
        if (Math.hypot(vx, vy) < W.REST_SPEED) {
          vx = 0;
          vy = 0;
        }
        Matter.Body.setVelocity(body, { x: vx, y: vy });
        if (vx !== 0 || vy !== 0) {
          Matter.Body.setPosition(body, {
            x: body.position.x + vx * subDt,
            y: body.position.y + vy * subDt,
          });
        }
      });
    }
  }

  // 棋子中心落入陷洞
  function isInHole(pos) {
    for (const h of holes) {
      if (Math.hypot(pos.x - h.x, pos.y - h.y) < h.r) return true;
    }
    return false;
  }

  function isOutOfBounds(pos) {
    const margin = 8;
    return (
      pos.x < W.boardLeft  - margin ||
      pos.x > W.boardRight + margin ||
      pos.y < W.boardTop   - margin ||
      pos.y > W.boardBottom + margin
    );
  }

  // ---------- 创建棋子 ----------
  function createPiece(wx, wy, team, slot) {
    const body = Matter.Bodies.circle(wx, wy, W.pieceRadius, {
      label: team,               // 'black' | 'white'
      restitution: 0.72,         // 弹性系数
      friction: 0.005,
      frictionAir: 0,
      mass: 1.0,
      density: 0.002,
    });
    body.gameTeam = team;
    body.slot = slot != null ? slot : 0;
    body.isGeneral = false;
    applyPieceMass(body);
    Matter.World.add(world, body);
    allPieces.push(body);
    return body;
  }

  // ---------- 删除棋子 ----------
  function removePiece(body) {
    Matter.World.remove(world, body);
    allPieces = allPieces.filter(b => b !== body);
  }

  // ---------- 创建障碍物 ----------
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

  // ---------- 删除所有障碍物 ----------
  function clearObstacles() {
    obstacles.forEach(b => Matter.World.remove(world, b));
    obstacles = [];
  }

  // ---------- 趣味局：反弹墙（沿边界的高弹静态体）----------
  // x,y 为中心，len 为长度，horizontal 决定方向
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

  // ---------- 趣味局：固定阻块（弱反弹静态体）----------
  function createBlock(x, y, size) {
    const s = size || 26;
    const body = Matter.Bodies.rectangle(x, y, s, s, {
      label: 'block',
      isStatic: true,
      restitution: 0.32,        // 弱反弹：撞上后能量被削弱
      friction: 0.2,
      angle: (Math.random() - 0.5) * 0.5,
    });
    body.blockSize = s;
    Matter.World.add(world, body);
    blocks.push(body);
    return body;
  }

  // ---------- 趣味局：陷洞（仅几何）----------
  function addHole(x, y, r) {
    holes.push({ x, y, r: r || W.pieceRadius * 2 });
  }

  function clearFunItems() {
    walls.forEach(b => Matter.World.remove(world, b));
    blocks.forEach(b => Matter.World.remove(world, b));
    walls = [];
    blocks = [];
    holes = [];
  }

  // ---------- 弹射棋子 ----------
  // 直接设置初速度（而非 applyForce），避免下一帧静摩擦逻辑在力转为速度前将其清零。
  function flingPiece(body, fx, fy) {
    const s = flingSpeedScale(body);
    body.force.x = 0;
    body.force.y = 0;
    Matter.Body.setVelocity(body, { x: fx * s, y: fy * s });
    Matter.Body.setAngularVelocity(body, 0);
  }

  // ---------- 所有棋子是否都静止 ----------
  function allStopped() {
    const toCheck = [...allPieces, ...obstacles];
    return toCheck.every(b => {
      const v = b.velocity;
      return Math.hypot(v.x, v.y) < W.REST_SPEED + 0.1;
    });
  }

  // ---------- 强制让所有刚体静止（超时兜底）----------
  function settleAll() {
    [...allPieces, ...obstacles].forEach(b => {
      Matter.Body.setVelocity(b, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(b, 0);
      b.force.x = 0;
      b.force.y = 0;
    });
  }

  // ---------- 重置整个世界 ----------
  function reset() {
    allPieces.forEach(b => Matter.World.remove(world, b));
    allPieces = [];
    clearObstacles();
    clearFunItems();
  }

  /**
   * 独立 Matter 沙盒 — 含障碍物、反弹墙、阻块、陷洞，与主局物理一致
   */
  function createSandbox() {
    const sbEngine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
    const sbWorld = sbEngine.world;
    const STEP_MS = 1000 / 60;
    const REST_FRAMES = 6;

    let sbPieces = [];
    let sbObstacles = [];
    let sbWalls = [];
    let sbBlocks = [];
    let sbHoles = [];
    let enemyContacts = 0;
    let wallHits = 0;
    let obstacleHits = 0;

    function sbIsInHole(pos) {
      for (const h of sbHoles) {
        if (Math.hypot(pos.x - h.x, pos.y - h.y) < h.r) return true;
      }
      return false;
    }

    function sbApplyFieldForces(body) {
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
          const fMag = W.DOME_FORCE_SCALE * slope * fieldForceMass(body);
          Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
        }
      }

      for (const cc of CORNER_CENTERS) {
        const dx = pos.x - cc.x;
        const dy = pos.y - cc.y;
        const dist = Math.hypot(dx, dy);
        if (dist < W.cornerBulgeRadius && dist > 0.5) {
          const slope = 2 * dist / (W.cornerBulgeRadius * W.cornerBulgeRadius);
          const fMag = W.CORNER_FORCE_SCALE * slope * fieldForceMass(body);
          Matter.Body.applyForce(body, pos, { x: (dx / dist) * fMag, y: (dy / dist) * fMag });
        }
      }

      if (body.special === 'curve' && speed > W.REST_SPEED) {
        const nx = vel.y / speed;
        const ny = -vel.x / speed;
        const fMag = CURVE_FORCE_SCALE * speed * fieldForceMass(body);
        Matter.Body.applyForce(body, pos, { x: nx * fMag, y: ny * fMag });
      }

      Matter.Body.setVelocity(body, {
        x: vel.x * W.DAMPING,
        y: vel.y * W.DAMPING,
      });
    }

    function sbRemovePiece(body) {
      Matter.World.remove(sbWorld, body);
      sbPieces = sbPieces.filter((b) => b !== body);
    }

    function sbRemoveObstacle(body) {
      Matter.World.remove(sbWorld, body);
      sbObstacles = sbObstacles.filter((b) => b !== body);
    }

    function sbCreatePiece(wx, wy, team, slot, special, isGeneral) {
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
      body.special = special || null;
      body.isGeneral = !!isGeneral;
      applyPieceMass(body);
      Matter.World.add(sbWorld, body);
      sbPieces.push(body);
      return body;
    }

    function sbIsTeamPiece(body) {
      return body && body.gameTeam && body.gameTeam !== 'obstacle';
    }

    function sbIsEnemyTeam(team, myTeam) {
      return team && team !== myTeam && team !== 'obstacle';
    }

    function sbCreateObstacle(wx, wy, r) {
      const body = Matter.Bodies.circle(wx, wy, r || W.obstacleRadius, {
        label: 'obstacle',
        restitution: 0.5,
        friction: 0.01,
        frictionAir: 0,
        mass: 2.5,
        density: 0.005,
      });
      body.gameTeam = 'obstacle';
      Matter.World.add(sbWorld, body);
      sbObstacles.push(body);
      return body;
    }

    function sbCreateWall(x, y, len, horizontal) {
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
      Matter.World.add(sbWorld, body);
      sbWalls.push(body);
      return body;
    }

    function sbCreateBlock(x, y, size, angle) {
      const s = size || 26;
      const body = Matter.Bodies.rectangle(x, y, s, s, {
        label: 'block',
        isStatic: true,
        restitution: 0.32,
        friction: 0.2,
        angle: angle || 0,
      });
      body.blockSize = s;
      Matter.World.add(sbWorld, body);
      sbBlocks.push(body);
      return body;
    }

    function sbClear() {
      sbPieces.forEach((b) => Matter.World.remove(sbWorld, b));
      sbObstacles.forEach((b) => Matter.World.remove(sbWorld, b));
      sbWalls.forEach((b) => Matter.World.remove(sbWorld, b));
      sbBlocks.forEach((b) => Matter.World.remove(sbWorld, b));
      sbPieces = [];
      sbObstacles = [];
      sbWalls = [];
      sbBlocks = [];
      sbHoles = [];
    }

    function sbFling(body, fx, fy) {
      const s = flingSpeedScale(body);
      body.force.x = 0;
      body.force.y = 0;
      Matter.Body.setVelocity(body, { x: fx * s, y: fy * s });
      Matter.Body.setAngularVelocity(body, 0);
    }

    function sbAllStopped() {
      const toCheck = [...sbPieces, ...sbObstacles];
      return toCheck.every((b) => Math.hypot(b.velocity.x, b.velocity.y) < W.REST_SPEED + 0.1);
    }

    function sbCullFallen() {
      const fallen = [];
      sbPieces.slice().forEach((p) => {
        const inHole = sbIsInHole(p.position);
        const oob = isOutOfBounds(p.position);
        if (inHole || oob) {
          fallen.push({ body: p, inHole, oob });
          sbRemovePiece(p);
        }
      });
      sbObstacles.slice().forEach((o) => {
        if (isOutOfBounds(o.position) || sbIsInHole(o.position)) {
          sbRemoveObstacle(o);
        }
      });
      return fallen;
    }

    function sbLoadFunTerrain() {
      getObstacles().forEach((o) => {
        sbCreateObstacle(o.position.x, o.position.y, o.circleRadius);
      });
      getWalls().forEach((w) => {
        sbCreateWall(w.position.x, w.position.y, w.wallLen, w.wallHorizontal);
      });
      getBlocks().forEach((b) => {
        sbCreateBlock(b.position.x, b.position.y, b.blockSize, b.angle);
      });
      getHoles().forEach((h) => {
        sbHoles.push({ x: h.x, y: h.y, r: h.r });
      });
    }

    Matter.Events.on(sbEngine, 'collisionStart', (e) => {
      e.pairs.forEach((pair) => {
        const { bodyA, bodyB } = pair;
        const isTeamPiece = sbIsTeamPiece;
        const isObstacle = (b) => b.label === 'obstacle';
        const isBarrier = (b) => b.label === 'wall' || b.label === 'block';

        if (isObstacle(bodyA) || isObstacle(bodyB)) {
          const other = isObstacle(bodyA) ? bodyB : bodyA;
          if (isTeamPiece(other) || isObstacle(other)) obstacleHits++;
        }

        if (isTeamPiece(bodyA) && isTeamPiece(bodyB)) {
          const tA = bodyA.gameTeam;
          const tB = bodyB.gameTeam;
          if (tA && tB && tA !== tB) enemyContacts++;
        }

        if (isBarrier(bodyA) || isBarrier(bodyB)) {
          const piece = isBarrier(bodyA) ? bodyB : bodyA;
          const barrier = isBarrier(bodyA) ? bodyA : bodyB;
          if (isTeamPiece(piece) || isObstacle(piece)) {
            if (barrier.label === 'wall' || barrier.label === 'block') wallHits++;
            if (barrier.label === 'block') piece._blockDamp = true;
          }
        }
      });
    });

    Matter.Events.on(sbEngine, 'beforeUpdate', () => {
      [...sbPieces, ...sbObstacles].forEach((p) => {
        if (p._blockDamp) {
          Matter.Body.setVelocity(p, { x: p.velocity.x * 0.55, y: p.velocity.y * 0.55 });
          p._blockDamp = false;
        }
        sbApplyFieldForces(p);
      });
    });

    function loadFromGame() {
      sbClear();
      getPieces().forEach((p) => {
        sbCreatePiece(p.position.x, p.position.y, p.gameTeam, p.slot, p.special, p.isGeneral);
      });
      sbLoadFunTerrain();
    }

    function sbEdgeMargin(pos) {
      const r = W.pieceRadius;
      return Math.min(
        pos.x - W.boardLeft - r,
        W.boardRight - pos.x - r,
        pos.y - W.boardTop - r,
        W.boardBottom - pos.y - r
      );
    }

    function sbHoleDanger(pos) {
      let best = Infinity;
      for (const h of sbHoles) {
        const d = Math.hypot(pos.x - h.x, pos.y - h.y) - h.r;
        if (d < best) best = d;
      }
      return best;
    }

    function sbComputeAttackScore(myTeam, metrics) {
      const {
        enemyFallen, ownFallen, enemyContacts, enemyHoleFalls, ownHoleFalls,
        shooterFell, shooterInHole, wallHits: wHits, obstacleHits: oHits,
        generalKills,
      } = metrics;

      let score = enemyFallen * 1200 - ownFallen * 900;
      score += (generalKills || 0) * 8000;
      score += enemyContacts * 12;
      score += enemyHoleFalls * 450;
      score -= ownHoleFalls * 600;
      if (shooterFell) score -= shooterInHole ? 1100 : 900;
      if (enemyFallen === 0 && enemyContacts > 0) score += enemyContacts * 8;
      if (wHits > 0 && (enemyFallen > 0 || enemyContacts > 0)) score += 70 + wHits * 12;
      if (oHits > 0 && (enemyFallen > 0 || enemyContacts > 0)) score += 50 + oHits * 8;

      sbPieces.filter((p) => sbIsEnemyTeam(p.gameTeam, myTeam)).forEach((ep) => {
        const em = sbEdgeMargin(ep.position);
        if (em < W.pieceRadius * 3) score += (W.pieceRadius * 3 - em) * 20;
        if (ep.isGeneral) score += (W.pieceRadius * 4 - Math.min(em, W.pieceRadius * 4)) * 8;
        if (sbHoles.length > 0) {
          const hd = sbHoleDanger(ep.position);
          if (hd < W.pieceRadius * 3) score += (W.pieceRadius * 3 - hd) * 16;
        }
      });
      sbPieces.filter((p) => p.gameTeam === myTeam).forEach((mp) => {
        const em = sbEdgeMargin(mp.position);
        if (em < W.pieceRadius * 2.5) score -= (W.pieceRadius * 2.5 - em) * 15;
        if (sbHoles.length > 0) {
          const hd = sbHoleDanger(mp.position);
          if (hd < W.pieceRadius * 2) score -= (W.pieceRadius * 2 - hd) * 12;
        }
      });

      return score;
    }

    function snapshotSbState() {
      return {
        pieces: sbPieces.map((p) => ({
          team: p.gameTeam,
          slot: p.slot,
          special: p.special,
          isGeneral: p.isGeneral,
          x: p.position.x,
          y: p.position.y,
          vx: p.velocity.x,
          vy: p.velocity.y,
        })),
        obstacles: sbObstacles.map((o) => ({
          x: o.position.x,
          y: o.position.y,
          vx: o.velocity.x,
          vy: o.velocity.y,
          r: o.circleRadius,
        })),
      };
    }

    function restoreSbState(snap) {
      sbPieces.forEach((b) => Matter.World.remove(sbWorld, b));
      sbObstacles.forEach((b) => Matter.World.remove(sbWorld, b));
      sbPieces = [];
      sbObstacles = [];
      snap.pieces.forEach((p) => {
        const body = sbCreatePiece(p.x, p.y, p.team, p.slot, p.special, p.isGeneral);
        Matter.Body.setPosition(body, { x: p.x, y: p.y });
        Matter.Body.setVelocity(body, { x: p.vx, y: p.vy });
      });
      snap.obstacles.forEach((o) => {
        const body = sbCreateObstacle(o.x, o.y, o.r);
        Matter.Body.setPosition(body, { x: o.x, y: o.y });
        Matter.Body.setVelocity(body, { x: o.vx, y: o.vy });
      });
    }

    function pickVulnerableSlot(victimTeam) {
      const victims = sbPieces.filter((p) => p.gameTeam === victimTeam);
      let worstSlot = victims[0] ? victims[0].slot : null;
      let worstVuln = Infinity;
      victims.forEach((v) => {
        const vuln = sbEdgeMargin(v.position) + sbHoleDanger(v.position) * 0.6;
        if (vuln < worstVuln) {
          worstVuln = vuln;
          worstSlot = v.slot;
        }
      });
      return worstSlot;
    }

    function quickThreatMetric(victimTeam, protectSlot) {
      const victim = sbPieces.find((p) => p.gameTeam === victimTeam && p.slot === protectSlot);
      if (!victim) return 0;
      let threat = -sbEdgeMargin(victim.position) * 2 - sbHoleDanger(victim.position);
      const attackers = sbPieces.filter((p) => p.gameTeam !== victimTeam);
      attackers.forEach((a) => {
        const d = Math.hypot(a.position.x - victim.position.x, a.position.y - victim.position.y);
        if (d < 140) threat += (140 - d) * 0.8;
      });
      return threat;
    }

    const SB_MAX_FORCE = 0.025;
    const THREAT_ANGLE_STEP = 30;
    const THREAT_FORCE_RATIOS = [0.45, 0.85];

    function assessThreatOnCurrentBoard(victimTeam) {
      const snap = snapshotSbState();
      const attackerTeams = [...new Set(
        snap.pieces.map((p) => p.team).filter((t) => sbIsEnemyTeam(t, victimTeam))
      )];

      let best = { maxKills: 0, threatScore: 0, targetSlot: null };
      const slotKillWeight = {};

      attackerTeams.forEach((attackerTeam) => {
        const attackers = snap.pieces.filter((p) => p.team === attackerTeam);
        attackers.forEach((ap) => {
          for (let deg = 0; deg < 360; deg += THREAT_ANGLE_STEP) {
            for (const ratio of THREAT_FORCE_RATIOS) {
              restoreSbState(snap);
              const rad = (deg / 180) * Math.PI;
              const forceMag = ratio * SB_MAX_FORCE;
              const r = runShotSimulation(
                attackerTeam,
                ap.slot,
                Math.cos(rad) * forceMag,
                Math.sin(rad) * forceMag
              );
              if (r.enemyFallen > 0) {
                (r.fallenEnemySlots || []).forEach((s) => {
                  slotKillWeight[s] = (slotKillWeight[s] || 0) + 1000 + r.score;
                });
                if (
                  r.enemyFallen > best.maxKills ||
                  (r.enemyFallen === best.maxKills && r.score > best.threatScore)
                ) {
                  best = {
                    maxKills: r.enemyFallen,
                    threatScore: r.score,
                    targetSlot: r.fallenEnemySlots[0] ?? best.targetSlot,
                  };
                }
              } else if (r.enemyContacts > 0 && best.maxKills === 0 && r.score * 0.25 > best.threatScore) {
                best.threatScore = r.score * 0.25;
              }
            }
          }
        });
      });

      restoreSbState(snap);

      let maxSlotWeight = -1;
      Object.entries(slotKillWeight).forEach(([s, w]) => {
        best.threatScore = Math.max(best.threatScore, w);
        if (w > maxSlotWeight) {
          maxSlotWeight = w;
          best.targetSlot = parseInt(s, 10);
        }
      });

      if (best.targetSlot == null) {
        best.targetSlot = pickVulnerableSlot(victimTeam);
        best.threatScore = Math.max(best.threatScore, quickThreatMetric(victimTeam, best.targetSlot));
      }

      return best;
    }

    function assessThreat(victimTeam) {
      loadFromGame();
      return assessThreatOnCurrentBoard(victimTeam);
    }

    function runShotSimulation(myTeam, slot, fx, fy) {
      enemyContacts = 0;
      wallHits = 0;
      obstacleHits = 0;

      const hasFunTerrain = sbHoles.length > 0 || sbWalls.length > 0 || sbBlocks.length > 0;
      const maxSteps = hasFunTerrain ? 480 : 360;

      const shooter = sbPieces.find((p) => p.gameTeam === myTeam && p.slot === slot);
      if (!shooter) {
        return {
          score: -9999,
          enemyFallen: 0,
          ownFallen: 0,
          enemyContacts: 0,
          fallenEnemySlots: [],
          fallenOwnSlots: [],
          shooterFell: false,
        };
      }

      const enemyStart = sbPieces.filter((p) => sbIsEnemyTeam(p.gameTeam, myTeam)).length;
      const ownStart = sbPieces.filter((p) => p.gameTeam === myTeam).length;
      const fallenEnemySlots = [];
      const fallenOwnSlots = [];
      let generalKills = 0;

      sbFling(shooter, fx, fy);
      let stillFrames = 0;
      let shooterFell = false;
      let shooterInHole = false;
      let enemyHoleFalls = 0;
      let ownHoleFalls = 0;

      for (let i = 0; i < maxSteps; i++) {
        Matter.Engine.update(sbEngine, STEP_MS);
        const fallen = sbCullFallen();
        for (const f of fallen) {
          const p = f.body;
          if (sbIsEnemyTeam(p.gameTeam, myTeam)) {
            fallenEnemySlots.push(p.slot);
            if (p.isGeneral) generalKills++;
          }
          if (p.gameTeam === myTeam) fallenOwnSlots.push(p.slot);
          if (p.gameTeam === myTeam && p.slot === slot) {
            shooterFell = true;
            if (f.inHole) shooterInHole = true;
          }
          if (sbIsEnemyTeam(p.gameTeam, myTeam) && f.inHole) enemyHoleFalls++;
          if (p.gameTeam === myTeam && f.inHole) ownHoleFalls++;
        }
        if (sbAllStopped()) {
          stillFrames++;
          if (stillFrames >= REST_FRAMES) break;
        } else {
          stillFrames = 0;
        }
      }

      const enemyEnd = sbPieces.filter((p) => sbIsEnemyTeam(p.gameTeam, myTeam)).length;
      const ownEnd = sbPieces.filter((p) => p.gameTeam === myTeam).length;
      const enemyFallen = enemyStart - enemyEnd;
      const ownFallen = ownStart - ownEnd;

      const score = sbComputeAttackScore(myTeam, {
        enemyFallen,
        ownFallen,
        enemyContacts,
        enemyHoleFalls,
        ownHoleFalls,
        shooterFell,
        shooterInHole,
        wallHits,
        obstacleHits,
        generalKills,
      });

      return {
        score,
        enemyFallen,
        ownFallen,
        enemyContacts,
        fallenEnemySlots,
        fallenOwnSlots,
        shooterFell,
      };
    }

    function evaluateShot(myTeam, slot, fx, fy) {
      loadFromGame();
      return runShotSimulation(myTeam, slot, fx, fy);
    }

    function evaluateDefenseShot(defenderTeam, slot, fx, fy, protectSlot, knownThreatBefore) {
      loadFromGame();
      const protectBefore = sbPieces.find((p) => p.gameTeam === defenderTeam && p.slot === protectSlot);
      const emBefore = protectBefore ? sbEdgeMargin(protectBefore.position) : 0;
      const hdBefore = protectBefore ? sbHoleDanger(protectBefore.position) : 0;
      const quickBefore = quickThreatMetric(defenderTeam, protectSlot);

      const threatBefore = knownThreatBefore || assessThreatOnCurrentBoard(defenderTeam);
      const ourResult = runShotSimulation(defenderTeam, slot, fx, fy);
      const threatAfter = assessThreatOnCurrentBoard(defenderTeam);
      const quickAfter = quickThreatMetric(defenderTeam, protectSlot);

      let defenseScore = threatBefore.threatScore - threatAfter.threatScore;
      defenseScore += (threatBefore.maxKills - threatAfter.maxKills) * 950;
      defenseScore += (quickBefore - quickAfter) * 35;
      defenseScore -= ourResult.ownFallen * 500;
      if (ourResult.shooterFell) defenseScore -= 350;

      const protectAfter = sbPieces.find((p) => p.gameTeam === defenderTeam && p.slot === protectSlot);
      if (protectAfter) {
        defenseScore += (sbEdgeMargin(protectAfter.position) - emBefore) * 30;
        defenseScore += (sbHoleDanger(protectAfter.position) - hdBefore) * 22;
      }

      if (ourResult.enemyContacts > 0 && ourResult.enemyFallen === 0) {
        defenseScore += ourResult.enemyContacts * 6;
      }

      return { defenseScore, ourResult, threatBefore, threatAfter };
    }

    function dispose() {
      sbClear();
      Matter.Engine.clear(sbEngine);
    }

    return { loadFromGame, evaluateShot, assessThreat, evaluateDefenseShot, dispose };
  }

  // ---------- Getter ----------
  function getPieces() { return allPieces; }
  function getObstacles() { return obstacles; }
  function getWalls() { return walls; }
  function getBlocks() { return blocks; }
  function getHoles() { return holes; }
  function getWorld() { return W; }

  // ---------- 回调注册 ----------
  function onCollision(cb) { onCollisionCb = cb; }
  function onWallHit(cb) { onWallHitCb = cb; }
  function onOutOfBounds(cb) { outOfBoundsCb = cb; }

  // ---------- 简单轨迹预测（不跑完整物理，近似计算）----------
  function predictTrajectory(startX, startY, vx, vy, steps) {
    const pts = [];
    let x = startX, y = startY;
    let dvx = vx, dvy = vy;
    const dt = 1 / 60;
    const damp = W.DAMPING;

    for (let i = 0; i < steps; i++) {
      // 丰腹力
      const dx = x - W.centerX;
      const dy = y - W.centerY;
      const dist = Math.hypot(dx, dy);
      if (dist < W.domeRadius && dist > 0.5) {
        const slope = 2 * dist / (W.domeRadius * W.domeRadius);
        const fMag = W.DOME_FORCE_SCALE * slope * 500;
        dvx += (dx / dist) * fMag * dt;
        dvy += (dy / dist) * fMag * dt;
      }
      // 四角微隆力
      for (const cc of CORNER_CENTERS) {
        const cdx = x - cc.x;
        const cdy = y - cc.y;
        const cdist = Math.hypot(cdx, cdy);
        if (cdist < W.cornerBulgeRadius && cdist > 0.5) {
          const slope = 2 * cdist / (W.cornerBulgeRadius * W.cornerBulgeRadius);
          const fMag = W.CORNER_FORCE_SCALE * slope * 500;
          dvx += (cdx / cdist) * fMag * dt;
          dvy += (cdy / cdist) * fMag * dt;
        }
      }

      dvx *= damp;
      dvy *= damp;
      x += dvx;
      y += dvy;

      pts.push({ x, y });

      if (isOutOfBounds({ x, y })) break;
      if (Math.hypot(dvx, dvy) < 0.5) break;
    }
    return pts;
  }

  function applyPieceMotion(pieces, opts) {
    if (pieces && pieces.length && Array.isArray(pieces[0])) {
      applyPieceMotionCompact(pieces, opts);
      return;
    }
    const snap = opts && opts.snap;
    const alpha = snap ? 1 : Math.min(1, (opts && opts.alpha) || 1);
    const map = {};
    allPieces.forEach(p => { map[`${p.gameTeam}:${p.slot}`] = p; });
    const live = new Set();
    (pieces || []).forEach(info => {
      const key = `${info.team}:${info.slot}`;
      live.add(key);
      let body = map[key];
      if (!body) {
        body = createPiece(info.x, info.y, info.team, info.slot);
        map[key] = body;
      }
      const tx = info.x;
      const ty = info.y;
      const x = body.position.x + (tx - body.position.x) * alpha;
      const y = body.position.y + (ty - body.position.y) * alpha;
      Matter.Body.setPosition(body, { x, y });
      Matter.Body.setVelocity(body, { x: info.vx || 0, y: info.vy || 0 });
      Matter.Body.setAngularVelocity(body, 0);
      if (info.special != null) body.special = info.special;
      else if ('special' in info) body.special = null;
    });
    allPieces.slice().forEach(p => {
      if (!live.has(`${p.gameTeam}:${p.slot}`)) removePiece(p);
    });
  }

  function decodeSpecialCode(code) {
    if (code === 1) return 'curve';
    if (code === 2) return 'speed';
    return null;
  }

  /** 紧凑行同步：精度不变，跳过未变化棋子以减少 Matter 写入 */
  function applyPieceMotionCompact(rows, opts) {
    const snap = opts && opts.snap;
    const alpha = snap ? 1 : Math.min(1, (opts && opts.alpha) || 1);
    const map = {};
    allPieces.forEach((p) => { map[`${p.gameTeam}:${p.slot}`] = p; });
    const live = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const team = row[0] === 0 ? 'black' : 'white';
      const slot = row[1];
      const key = `${team}:${slot}`;
      live.add(key);
      const tx = row[2];
      const ty = row[3];
      const tvx = row[4] || 0;
      const tvy = row[5] || 0;
      let body = map[key];
      if (!body) {
        body = createPiece(tx, ty, team, slot);
        map[key] = body;
      } else if (snap) {
        const px = body.position.x;
        const py = body.position.y;
        const vx = body.velocity.x;
        const vy = body.velocity.y;
        if (Math.abs(px - tx) < 0.01 && Math.abs(py - ty) < 0.01 &&
            Math.abs(vx - tvx) < 0.01 && Math.abs(vy - tvy) < 0.01) {
          if (row.length > 6) {
            const sp = decodeSpecialCode(row[6]);
            body.special = sp;
          }
          continue;
        }
      }
      const x = body.position.x + (tx - body.position.x) * alpha;
      const y = body.position.y + (ty - body.position.y) * alpha;
      Matter.Body.setPosition(body, { x, y });
      Matter.Body.setVelocity(body, { x: tvx, y: tvy });
      Matter.Body.setAngularVelocity(body, 0);
      if (row.length > 6) {
        body.special = decodeSpecialCode(row[6]);
      }
    }
    if (!(opts && opts.merge)) {
      allPieces.slice().forEach((p) => {
        if (!live.has(`${p.gameTeam}:${p.slot}`)) removePiece(p);
      });
    }
  }

  function setVisualOnly() { /* 已废弃：联机由服务端权威物理 + 同步帧驱动 */ }

  return {
    init,
    step,
    reset,
    setVisualOnly,
    extrapolatePositions,
    extrapolateWithDamping,
    createPiece,
    applyPieceMass,
    removePiece,
    createObstacle,
    clearObstacles,
    createWall,
    createBlock,
    addHole,
    clearFunItems,
    flingPiece,
    allStopped,
    settleAll,
    applyPieceMotion,
    applyPieceMotionCompact,
    getPieces,
    getObstacles,
    getWalls,
    getBlocks,
    getHoles,
    getWorld,
    isOutOfBounds,
    predictTrajectory,
    createSandbox,
    onCollision,
    onWallHit,
    onOutOfBounds,
    W,
  };
})();
