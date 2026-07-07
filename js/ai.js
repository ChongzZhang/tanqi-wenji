// 《弹棋问机》AI — 老者（启发式弹道）/ 大师（Matter 沙盒）

const AI = (() => {
  const MAX_FORCE = 0.025;
  const W = () => Physics.W;

  const MASTER_COARSE_ANGLE = 18;
  const MASTER_COARSE_RATIOS = [0.35, 0.55, 0.75, 0.95];
  const MASTER_FINE_TOP = 6;
  const MASTER_FINE_ANGLE_SPAN = 15;
  const MASTER_FINE_ANGLE_STEP = 3;
  const MASTER_FINE_RATIOS = [0.25, 0.4, 0.55, 0.7, 0.85, 1.0];

  const CORNER_CENTERS = () => {
    const ww = W();
    const r = ww.cornerBulgeRadius;
    return [
      { x: ww.boardLeft + r, y: ww.boardTop + r },
      { x: ww.boardRight - r, y: ww.boardTop + r },
      { x: ww.boardLeft + r, y: ww.boardBottom - r },
      { x: ww.boardRight - r, y: ww.boardBottom - r },
    ];
  };

  function edgeMargin(pos, ww) {
    const r = ww.pieceRadius;
    return Math.min(
      pos.x - ww.boardLeft - r,
      ww.boardRight - pos.x - r,
      pos.y - ww.boardTop - r,
      ww.boardBottom - pos.y - r
    );
  }

  function isOutOfBoundsSim(x, y, ww) {
    const margin = 8;
    return (
      x < ww.boardLeft - margin ||
      x > ww.boardRight + margin ||
      y < ww.boardTop - margin ||
      y > ww.boardBottom + margin
    );
  }

  function nearestEdgeDir(pos, ww) {
    const mL = pos.x - ww.boardLeft;
    const mR = ww.boardRight - pos.x;
    const mT = pos.y - ww.boardTop;
    const mB = ww.boardBottom - pos.y;
    const min = Math.min(mL, mR, mT, mB);
    if (min === mL) return { x: -1, y: 0 };
    if (min === mR) return { x: 1, y: 0 };
    if (min === mT) return { x: 0, y: -1 };
    return { x: 0, y: 1 };
  }

  function applySimForces(x, y, dvx, dvy, dt, ww) {
    let vx = dvx;
    let vy = dvy;

    const dx = x - ww.centerX;
    const dy = y - ww.centerY;
    const dist = Math.hypot(dx, dy);
    if (dist < ww.domeRadius && dist > 0.5) {
      const slope = 2 * dist / (ww.domeRadius * ww.domeRadius);
      const fMag = ww.DOME_FORCE_SCALE * slope * 500;
      vx += (dx / dist) * fMag * dt;
      vy += (dy / dist) * fMag * dt;
    }

    for (const cc of CORNER_CENTERS()) {
      const cdx = x - cc.x;
      const cdy = y - cc.y;
      const cd = Math.hypot(cdx, cdy);
      if (cd < ww.cornerBulgeRadius && cd > 0.5) {
        const slope = 2 * cd / (ww.cornerBulgeRadius * ww.cornerBulgeRadius);
        const fMag = ww.CORNER_FORCE_SCALE * slope * 500;
        vx += (cdx / cd) * fMag * dt;
        vy += (cdy / cd) * fMag * dt;
      }
    }

    return { dvx: vx, dvy: vy };
  }

  function computeMove(level, myTeam) {
    const allPieces = Physics.getPieces();
    const myPieces = allPieces.filter(p => p.gameTeam === myTeam);
    const enemies = allPieces.filter(p => p.gameTeam !== myTeam);
    const obstacles = Physics.getObstacles();

    if (myPieces.length === 0) return null;
    if (enemies.length === 0) return randomMove(myPieces);

    switch (level) {
      case 2: return masterMove(myPieces, enemies, myTeam);
      case 1:
      default: return elderMove(myPieces, enemies, obstacles);
    }
  }

  function elderMove(myPieces, enemies, obstacles) {
    let bestShot = null;
    let bestScore = -Infinity;
    const ww = W();

    myPieces.forEach(piece => {
      const startEdge = edgeMargin(piece.position, ww);
      for (let angleDeg = 0; angleDeg < 360; angleDeg += 8) {
        const angle = (angleDeg / 180) * Math.PI;
        [0.3, 0.6, 0.9].forEach(ratio => {
          const forceMag = ratio * MAX_FORCE;
          const vx = Math.cos(angle) * forceMag * ww.FLING_SPEED_SCALE;
          const vy = Math.sin(angle) * forceMag * ww.FLING_SPEED_SCALE;

          const edgeDir = nearestEdgeDir(piece.position, ww);
          const outward = vx * edgeDir.x + vy * edgeDir.y;
          if (startEdge < ww.pieceRadius * 2 && outward > 0.5) return;

          const score = simulateAndScore(piece, vx, vy, myPieces, enemies);
          if (score > bestScore) {
            bestScore = score;
            bestShot = {
              piece,
              fx: Math.cos(angle) * forceMag,
              fy: Math.sin(angle) * forceMag,
              strength: ratio,
            };
          }
        });
      }
    });

    return bestShot || aimWeakestEdgeEnemy(myPieces, enemies);
  }

  function aimWeakestEdgeEnemy(myPieces, enemies) {
    const ww = W();
    const target = enemies.slice().sort((a, b) => edgeMargin(a.position, ww) - edgeMargin(b.position, ww))[0];
    let bestPiece = myPieces[0];
    let bestD = Infinity;
    myPieces.forEach(p => {
      const d = Math.hypot(p.position.x - target.position.x, p.position.y - target.position.y);
      if (d < bestD) { bestD = d; bestPiece = p; }
    });

    const dx = target.position.x - bestPiece.position.x;
    const dy = target.position.y - bestPiece.position.y;
    const edgeDir = nearestEdgeDir(target.position, ww);
    const align = dx * edgeDir.x + dy * edgeDir.y;
    const boost = align > 0 ? 1.05 : 0.92;
    const d = Math.hypot(dx, dy);
    const forceMag = Math.min(0.45 + d / 380, 0.92) * MAX_FORCE * boost;
    const angle = Math.atan2(dy, dx);

    return {
      piece: bestPiece,
      fx: Math.cos(angle) * forceMag,
      fy: Math.sin(angle) * forceMag,
      strength: forceMag / MAX_FORCE,
    };
  }

  function shotCandidate(piece, angleRad, ratio) {
    const forceMag = ratio * MAX_FORCE;
    return {
      piece,
      fx: Math.cos(angleRad) * forceMag,
      fy: Math.sin(angleRad) * forceMag,
      strength: ratio,
      angleRad,
      ratio,
    };
  }

  function masterCollectCandidates(sandbox, myTeam, myPieces) {
    const candidates = [];
    const ww = W();

    myPieces.forEach((piece) => {
      const startEdge = edgeMargin(piece.position, ww);
      for (let angleDeg = 0; angleDeg < 360; angleDeg += MASTER_COARSE_ANGLE) {
        const angleRad = (angleDeg / 180) * Math.PI;
        MASTER_COARSE_RATIOS.forEach((ratio) => {
          const shot = shotCandidate(piece, angleRad, ratio);
          const edgeDir = nearestEdgeDir(piece.position, ww);
          const outward = shot.fx * edgeDir.x + shot.fy * edgeDir.y;
          if (startEdge < ww.pieceRadius * 2 && outward > 0.012) return;

          const result = sandbox.evaluateShot(myTeam, piece.slot, shot.fx, shot.fy);
          candidates.push({ ...shot, score: result.score, enemyFallen: result.enemyFallen });
        });
      }
    });

    candidates.sort((a, b) => b.score - a.score);
    const refinePool = candidates.slice(0, MASTER_FINE_TOP);

    refinePool.forEach((base) => {
      const centerDeg = (base.angleRad * 180) / Math.PI;
      for (let d = -MASTER_FINE_ANGLE_SPAN; d <= MASTER_FINE_ANGLE_SPAN; d += MASTER_FINE_ANGLE_STEP) {
        const angleRad = ((centerDeg + d) / 180) * Math.PI;
        MASTER_FINE_RATIOS.forEach((ratio) => {
          const shot = shotCandidate(base.piece, angleRad, ratio);
          const result = sandbox.evaluateShot(myTeam, base.piece.slot, shot.fx, shot.fy);
          candidates.push({ ...shot, score: result.score, enemyFallen: result.enemyFallen });
        });
      }
    });

    return candidates;
  }

  function shotToMove(shot) {
    return {
      piece: shot.piece,
      fx: shot.fx,
      fy: shot.fy,
      strength: shot.strength,
    };
  }

  const MASTER_DEFENSE_POOL = 12;

  function masterDefensiveMove(sandbox, myTeam, candidates) {
    const threatBefore = sandbox.assessThreat(myTeam);
    const protectSlot = threatBefore.targetSlot;

    const pool = candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, MASTER_DEFENSE_POOL);

    pool.forEach((c) => {
      const def = sandbox.evaluateDefenseShot(
        myTeam,
        c.piece.slot,
        c.fx,
        c.fy,
        protectSlot,
        threatBefore
      );
      c.score = def.defenseScore;
      c.defenseMode = true;
      c.protectSlot = protectSlot;
    });

    pool.sort((a, b) => b.score - a.score);
    return pool[0] ? shotToMove(pool[0]) : null;
  }

  function masterMove(myPieces, enemies, myTeam) {
    if (typeof Physics.createSandbox !== 'function') {
      return elderMove(myPieces, enemies, []);
    }

    const sandbox = Physics.createSandbox();

    try {
      const candidates = masterCollectCandidates(sandbox, myTeam, myPieces);
      const killShots = candidates.filter((c) => c.enemyFallen > 0);

      if (killShots.length > 0) {
        killShots.sort((a, b) => b.score - a.score || b.enemyFallen - a.enemyFallen);
        return shotToMove(killShots[0]);
      }

      const defensive = masterDefensiveMove(sandbox, myTeam, candidates);
      if (defensive) return defensive;
    } finally {
      sandbox.dispose();
    }

    return elderMove(myPieces, enemies, []);
  }

  function simulateAndScore(piece, vx, vy, myPieces, enemies) {
    const ww = W();
    const R = ww.pieceRadius;
    let x = piece.position.x;
    let y = piece.position.y;
    let dvx = vx;
    let dvy = vy;
    let score = 0;
    const dt = 1 / 60;
    const DAMPING = ww.DAMPING;

    const startEdge = edgeMargin({ x, y }, ww);
    if (startEdge < R * 2) {
      const edgeDir = nearestEdgeDir({ x, y }, ww);
      const outward = dvx * edgeDir.x + dvy * edgeDir.y;
      if (outward > 0) score -= 60 + outward * 0.2;
    }

    const enemyState = enemies.map(e => ({
      x: e.position.x,
      y: e.position.y,
      dvx: 0,
      dvy: 0,
      hit: false,
      fallen: false,
    }));

    for (let step = 0; step < 200; step++) {
      ({ dvx, dvy } = applySimForces(x, y, dvx, dvy, dt, ww));
      dvx *= DAMPING;
      dvy *= DAMPING;
      x += dvx;
      y += dvy;

      if (isOutOfBoundsSim(x, y, ww)) {
        score -= 400;
        break;
      }

      for (const es of enemyState) {
        if (es.fallen) continue;
        const edx = x - es.x;
        const edy = y - es.y;
        const dist = Math.hypot(edx, edy);
        if (dist < R * 2.2 && dist > 0.01) {
          if (!es.hit) {
            es.hit = true;
            const edgeBefore = edgeMargin({ x: es.x, y: es.y }, ww);
            const nx = edx / dist;
            const ny = edy / dist;
            const relSpeed = Math.hypot(dvx, dvy);
            es.dvx = nx * relSpeed * 0.88;
            es.dvy = ny * relSpeed * 0.88;
            const edgeDir = nearestEdgeDir({ x: es.x, y: es.y }, ww);
            const align = es.dvx * edgeDir.x + es.dvy * edgeDir.y;
            score += 140 - edgeBefore * 0.5 + Math.max(0, align) * 0.2;
          }
          dvx *= 0.25;
          dvy *= 0.25;
        }
      }

      for (const es of enemyState) {
        if (!es.hit || es.fallen) continue;
        ({ dvx: es.dvx, dvy: es.dvy } = applySimForces(es.x, es.y, es.dvx, es.dvy, dt, ww));
        es.dvx *= DAMPING;
        es.dvy *= DAMPING;
        es.x += es.dvx;
        es.y += es.dvy;
        if (isOutOfBoundsSim(es.x, es.y, ww)) {
          score += 600;
          es.fallen = true;
        }
      }

      for (const mp of myPieces) {
        if (mp === piece) continue;
        const mdx = x - mp.position.x;
        const mdy = y - mp.position.y;
        if (Math.hypot(mdx, mdy) < R * 2) score -= 25;
      }

      const allSlow = Math.hypot(dvx, dvy) < 0.5;
      const enemiesSlow = enemyState.every(es => !es.hit || es.fallen || Math.hypot(es.dvx, es.dvy) < 0.5);
      if (allSlow && enemiesSlow) break;
    }

    for (const es of enemyState) {
      if (es.fallen) continue;
      const em = edgeMargin({ x: es.x, y: es.y }, ww);
      if (em < R * 3) score += (R * 3 - em) * 10;
    }

    return score;
  }

  function randomMove(myPieces) {
    const piece = myPieces[Math.floor(Math.random() * myPieces.length)];
    const angle = Math.random() * Math.PI * 2;
    const forceMag = (0.3 + Math.random() * 0.6) * MAX_FORCE;
    return { piece, fx: Math.cos(angle) * forceMag, fy: Math.sin(angle) * forceMag, strength: forceMag / MAX_FORCE };
  }

  function computeLayout(team, existingPieces) {
    const ww = W();
    let zoneTop, zoneBottom;
    if (team === 'white') {
      zoneTop = ww.boardTop + 15;
      zoneBottom = ww.boardTop + ww.boardSize * 0.4;
    } else {
      zoneTop = ww.boardTop + ww.boardSize * 0.6;
      zoneBottom = ww.boardBottom - 15;
    }

    const positions = [];
    const R = ww.pieceRadius;
    let attempts = 0;

    while (positions.length < 6 && attempts < 1000) {
      attempts++;
      const x = ww.boardLeft + 20 + Math.random() * (ww.boardSize - 40);
      const y = zoneTop + Math.random() * (zoneBottom - zoneTop);

      const tooClose = [...existingPieces, ...positions].some(p => {
        const px = p.position ? p.position.x : p.x;
        const py = p.position ? p.position.y : p.y;
        return Math.hypot(px - x, py - y) < R * 2.5;
      });

      if (!tooClose) positions.push({ x, y });
    }

    return positions;
  }

  return { computeMove, computeLayout };
})();
