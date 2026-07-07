// 《幽寂弹棋》渲染引擎 — Canvas 2D 水墨画风

const Renderer = (() => {
  let canvas, ctx;

  // 摄影机状态（2D 平移/缩放 + 3D 偏航/俯仰）
  const PITCH_MIN = 0;
  const PITCH_MAX = 1.22;          // ≈70°，可看到隆起侧面但不翻到盘底
  const cam = {
    wx: 300, wy: 300,              // 对准的世界坐标（盘心）
    zoom: 1,
    yaw: 0,                        // 绕竖轴旋转（弧度）
    pitch: 0.32,                   // 俯仰，默认轻微立体感（0=纯俯视）
    targetWx: 300, targetWy: 300, targetZoom: 1,
    targetYaw: 0, targetPitch: 0.32,
    lerpSpeed: 0.12,
    camDist: 1100,                 // 透视相机距离
    focal: 1100,                   // 焦距
  };

  let baseScale = 1;
  let baseOffX = 0, baseOffY = 0;
  let viewportInsetTop = 0;
  let viewportInsetBottom = 0;
  let ffaViewMode = false;

  function setFFAViewMode(on) {
    ffaViewMode = !!on;
    updateBaseTransform();
  }

  function setViewportInsets(top, bottom) {
    viewportInsetTop = Math.max(0, top || 0);
    viewportInsetBottom = Math.max(0, bottom || 0);
  }

  // 粒子池
  let particles = [];

  // ---------- 初始化 ----------
  function init(c) {
    canvas = c;
    ctx = c.getContext('2d');
    updateBaseTransform();
  }

  function getBoardTopScreenY() {
    const W = Physics.W;
    const pts = [];
    const corners = [
      [W.boardLeft, W.boardTop],
      [W.boardRight, W.boardTop],
      [W.boardRight, W.boardBottom],
      [W.boardLeft, W.boardBottom],
      [W.centerX, W.centerY],
    ];
    for (let i = 0; i <= 12; i++) {
      const wx = W.boardLeft + (W.boardSize * i) / 12;
      pts.push([wx, W.boardTop]);
    }
    pts.push([W.centerX, W.boardTop - 4]);
    corners.forEach(c => pts.push(c));
    let minY = Infinity;
    for (const [wx, wy] of pts) {
      const sp = project(wx, wy, surfaceHeight(wx, wy));
      if (sp.y < minY) minY = sp.y;
    }
    return minY - worldToScreenLen(ffaViewMode ? 8 : 4);
  }

  function clampBoardBelowHud() {
    if (viewportInsetTop <= 0) return;
    const slack = viewW() < 520 ? 32 : 44;
    const minTop = viewportInsetTop + slack;
    for (let i = 0; i < 16; i++) {
      const top = getBoardTopScreenY();
      if (top >= minTop) break;
      baseOffY += minTop - top;
    }
  }

  function updateBaseTransform() {
    const W = Physics.W;
    const vw = viewW();
    const vh = viewH();
    const worldSpan = 510;
    const narrow = vw < 520 || vh < 520;
    const edgePad = narrow ? 8 : 14;
    const marginX = narrow ? 8 : 12;
    const marginTop = viewportInsetTop > 0 ? viewportInsetTop + edgePad : (narrow ? 8 : 12);
    const marginBottom = viewportInsetBottom > 0 ? viewportInsetBottom + edgePad : (narrow ? 8 : 12);
    baseScale = Math.min(
      (vw - marginX * 2) / worldSpan,
      (vh - marginTop - marginBottom) / worldSpan
    );
    baseScale = Math.max(baseScale, 0.35);
    if (ffaViewMode) {
      baseScale *= viewW() < 520 || viewH() < 520 ? 0.86 : 0.90;
    } else if (viewportInsetTop <= 0) {
      if (narrow) baseScale *= 1.14;
      else if (vw >= 720) baseScale *= 1.06;
    }
    baseOffX = (vw - worldSpan * baseScale) / 2;
    baseOffY = marginTop + (vh - marginTop - marginBottom - worldSpan * baseScale) / 2;
    clampBoardBelowHud();
  }

  function viewW() {
    if (!canvas) return window.innerWidth;
    return canvas.clientWidth || Math.round(canvas.width / (canvas._dpr || 1));
  }

  function viewH() {
    if (!canvas) return window.innerHeight;
    return canvas.clientHeight || Math.round(canvas.height / (canvas._dpr || 1));
  }

  // ---------- 高度场（纯视觉，物理不受影响）----------
  const DOME_PEAK = 64;            // 丰腹峰值高度（世界单位）
  const CORNER_PEAK = 14;          // 四角微隆高度

  function surfaceHeight(wx, wy) {
    const W = Physics.W;
    let h = 0;
    // 丰腹：余弦凸包
    const dx = wx - W.centerX, dy = wy - W.centerY;
    const d = Math.hypot(dx, dy);
    if (d < W.domeRadius) {
      h += DOME_PEAK * 0.5 * (1 + Math.cos(Math.PI * d / W.domeRadius));
    }
    // 四角微隆
    const corners = [
      [W.boardLeft + W.cornerBulgeRadius,  W.boardTop + W.cornerBulgeRadius],
      [W.boardRight - W.cornerBulgeRadius, W.boardTop + W.cornerBulgeRadius],
      [W.boardLeft + W.cornerBulgeRadius,  W.boardBottom - W.cornerBulgeRadius],
      [W.boardRight - W.cornerBulgeRadius, W.boardBottom - W.cornerBulgeRadius],
    ];
    for (const c of corners) {
      const cd = Math.hypot(wx - c[0], wy - c[1]);
      if (cd < W.cornerBulgeRadius) {
        h += CORNER_PEAK * 0.5 * (1 + Math.cos(Math.PI * cd / W.cornerBulgeRadius));
      }
    }
    return h;
  }

  // ---------- 3D 投影：世界(wx,wy,wz) → 屏幕 {x,y,depth,scale} ----------
  function project(wx, wy, wz) {
    const cosY = Math.cos(cam.yaw),   sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);

    const dx = (wx - cam.wx);
    const dy = (wy - cam.wy);
    const dz = (wz || 0);

    // 绕竖轴(yaw)
    const rx = dx * cosY - dy * sinY;
    const ry = dx * sinY + dy * cosY;
    const rz = dz;

    // 绕横轴(pitch)
    const tx = rx;
    const ty = ry * cosP - rz * sinP;
    const tz = ry * sinP + rz * cosP;   // 深度：越大越靠近相机

    const persp = cam.focal / (cam.camDist - tz);
    const S = baseScale * cam.zoom * persp;
    const vw = viewW();
    const vh = viewH();
    return {
      x: vw / 2 + tx * S,
      y: vh / 2 + ty * S,
      depth: tz,
      scale: S,
    };
  }

  // 兼容旧接口：世界→屏幕（取盘面高度）
  function worldToScreen(wx, wy) {
    return project(wx, wy, surfaceHeight(wx, wy));
  }

  // 屏幕 → 世界（反投影到 z=0 基准平面，迭代消除透视）
  function screenToWorldPlane(sx, sy) {
    const cosY = Math.cos(cam.yaw),   sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch), sinP = Math.sin(cam.pitch);
    const vw = viewW();
    const vh = viewH();
    const u = (sx - vw / 2) / (baseScale * cam.zoom);
    const v = (sy - vh / 2) / (baseScale * cam.zoom);
    // z=0 平面：rz=0 → tz = ry*sinP, ty = ry*cosP, tx = rx
    let persp = 1, ry = 0;
    for (let i = 0; i < 6; i++) {
      ry = v / (cosP * persp || 1e-3);
      const tz = ry * sinP;
      persp = cam.focal / (cam.camDist - tz);
    }
    const rx = u / persp;
    // 反 yaw
    const dx = rx * cosY + ry * sinY;
    const dy = -rx * sinY + ry * cosY;
    return { x: cam.wx + dx, y: cam.wy + dy };
  }

  // 旧名兼容
  function screenToWorld(sx, sy) { return screenToWorldPlane(sx, sy); }

  // 世界单位 → 屏幕像素长度（按盘心透视近似）
  function worldToScreenLen(len) {
    const persp = cam.focal / (cam.camDist - 0);
    return len * baseScale * cam.zoom * persp;
  }

  // ---------- 棋子拾取（屏幕命中 + 世界坐标兜底，贴边/触屏友好）----------
  function isTouchDevice() {
    return typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
  }

  function pickSlopPx() {
    const narrow = viewW() < 520 || viewH() < 520;
    if (isTouchDevice()) return narrow ? 42 : 34;
    return 12;
  }

  function pieceScreenAnchor(body) {
    const px = body.position.x;
    const py = body.position.y;
    const hs = surfaceHeight(px, py);
    const thick = Physics.W.pieceRadius * 1.5;
    const Pb = project(px, py, hs);
    const Pt = project(px, py, hs + thick);
    const R = Physics.W.pieceRadius * Pt.scale;
    return { x: Pb.x, y: Pb.y, depth: Pb.depth, radius: R + pickSlopPx() };
  }

  function pickPieceByScreen(sx, sy, team) {
    let best = null;
    let bestDepth = -Infinity;
    Physics.getPieces().forEach(p => {
      if (team && p.gameTeam !== team) return;
      const anchor = pieceScreenAnchor(p);
      if (Math.hypot(anchor.x - sx, anchor.y - sy) <= anchor.radius && anchor.depth > bestDepth) {
        best = p;
        bestDepth = anchor.depth;
      }
    });
    return best;
  }

  function pickPieceByWorld(sx, sy, team) {
    const w = screenToWorldPlane(sx, sy);
    const W = Physics.W;
    const slop = isTouchDevice() ? 24 : 16;
    let best = null;
    let bestDist = Infinity;
    Physics.getPieces().forEach(p => {
      if (team && p.gameTeam !== team) return;
      const d = Math.hypot(p.position.x - w.x, p.position.y - w.y);
      if (d <= W.pieceRadius + slop && d < bestDist) {
        best = p;
        bestDist = d;
      }
    });
    return best;
  }

  function pickPiece(sx, sy, team) {
    return pickPieceByScreen(sx, sy, team) || pickPieceByWorld(sx, sy, team);
  }

  // 旋转视角（输入层调用）
  function rotateBy(dYaw, dPitch) {
    cam.targetYaw += dYaw;
    cam.targetPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, cam.targetPitch + dPitch));
  }
  function resetView() {
    if (ffaViewMode) {
      setCameraForFFA(true);
      cam.targetZoom = 1;
      cam.zoom = 1;
      return;
    }
    cam.targetYaw = 0;
    cam.targetPitch = 0.32;
    cam.targetZoom = 1;
  }

  // ---------- 摄影机更新 ----------
  function updateCamera() {
    cam.wx    += (cam.targetWx    - cam.wx)    * cam.lerpSpeed;
    cam.wy    += (cam.targetWy    - cam.wy)    * cam.lerpSpeed;
    cam.zoom  += (cam.targetZoom  - cam.zoom)  * cam.lerpSpeed;
    cam.yaw   += (cam.targetYaw   - cam.yaw)   * cam.lerpSpeed;
    cam.pitch += (cam.targetPitch - cam.pitch) * cam.lerpSpeed;
  }

  function setCameraOverview() {
    cam.targetWx = 300;
    cam.targetWy = 300;
    cam.targetZoom = 1;
    if (!ffaViewMode) {
      cam.targetYaw = 0;
      cam.targetPitch = 0.32;
    }
  }

  /** 四方乱战：菱形视角（-45°），玩家区(白/左下)始终在屏幕下方 */
  function setCameraForFFA(immediate = false) {
    const yaw = (typeof Teams !== 'undefined' && Teams.FFA_CAMERA_YAW != null)
      ? Teams.FFA_CAMERA_YAW
      : -Math.PI / 4;
    cam.targetWx = 300;
    cam.targetWy = 300;
    cam.targetZoom = 1;
    cam.targetYaw = yaw;
    cam.targetPitch = 0.32;
    if (immediate) {
      cam.wx = 300;
      cam.wy = 300;
      cam.zoom = 1;
      cam.yaw = yaw;
      cam.pitch = 0.32;
    }
  }

  /** 双人对弈：当前行棋方一侧在屏幕下方（黑=0，白=π） */
  function setCameraForTurn(team, immediate = false) {
    const yaw = team === 'white' ? Math.PI : 0;
    cam.targetYaw = yaw;
    if (immediate) {
      cam.yaw = yaw;
    }
  }

  function setCameraFollow(wx, wy, immediate = false) {
    cam.targetWx = wx;
    cam.targetWy = wy;
    cam.targetZoom = 1.35;
    if (immediate) {
      cam.wx = wx;
      cam.wy = wy;
      cam.zoom = cam.targetZoom;
    }
  }

  // ---------- 辅助：圆角矩形 ----------
  function roundRect(x, y, w, h, r) {
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

  let _bgTime = 0;

  // ---------- 背景场景 ----------
  function drawBackground(skinId) {
    ctx.save();
    const vw = viewW();
    const vh = viewH();

    const bgGrad = ctx.createLinearGradient(0, 0, 0, vh);
    bgGrad.addColorStop(0, '#F3EBD8');
    bgGrad.addColorStop(0.5, '#EDE3CF');
    bgGrad.addColorStop(1, '#E5D9C4');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, vw, vh);

    drawInkMountains();

    const mistGrad = ctx.createLinearGradient(0, 0, 0, vh);
    mistGrad.addColorStop(0, 'rgba(243,235,216,0.45)');
    mistGrad.addColorStop(0.4, 'rgba(243,235,216,0)');
    mistGrad.addColorStop(0.75, 'rgba(243,235,216,0)');
    mistGrad.addColorStop(1, 'rgba(229,217,196,0.5)');
    ctx.fillStyle = mistGrad;
    ctx.fillRect(0, 0, vw, vh);

    ctx.restore();
  }

  function drawInkMountains() {
    const h = viewH();
    const w = viewW();

    // 远山（极淡）
    ctx.fillStyle = 'rgba(130,145,155,0.07)';
    drawMountainShape([0, 0, 0.15, 0.25, 0.3, 0.18, 0.5, 0.3, 0.65, 0.12, 0.8, 0.22, 1, 0], w, h * 0.55);

    ctx.fillStyle = 'rgba(110,125,135,0.06)';
    drawMountainShape([0, 0.05, 0.2, 0.2, 0.4, 0.28, 0.6, 0.15, 0.85, 0.25, 1, 0.05], w, h * 0.6);

    // 近山（稍深）
    ctx.fillStyle = 'rgba(90,100,110,0.08)';
    drawMountainShape([0, 0, 0.1, 0.15, 0.25, 0.12, 0.45, 0.2, 0.6, 0.08, 0.75, 0.18, 1, 0], w, h * 0.68);
  }

  function drawMountainShape(pts, totalW, baseY) {
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    for (let i = 0; i < pts.length; i += 2) {
      ctx.lineTo(pts[i] * totalW, baseY - pts[i + 1] * baseY * 0.7);
    }
    ctx.lineTo(totalW, baseY);
    ctx.closePath();
    ctx.fill();
  }

  function drawBamboo(baseX, baseY, scale) {
    // 节数必须确定（不可每帧随机，否则竹子会高速闪烁）
    const nodeCount = 8;
    const segH = 55 * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(80, 110, 60, 0.18)';
    ctx.lineWidth = 4 * scale;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    let cy = baseY;
    for (let i = 0; i < nodeCount; i++) {
      ctx.lineTo(baseX + Math.sin(i * 0.5) * 6 * scale, cy - segH);
      cy -= segH;
    }
    ctx.stroke();

    // 节点
    ctx.strokeStyle = 'rgba(60, 90, 40, 0.22)';
    ctx.lineWidth = 5 * scale;
    cy = baseY;
    for (let i = 0; i < nodeCount; i++) {
      cy -= segH;
      ctx.beginPath();
      ctx.arc(baseX + Math.sin(i * 0.5) * 6 * scale, cy, 4 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 叶片
    ctx.fillStyle = 'rgba(70, 110, 50, 0.15)';
    cy = baseY;
    for (let i = 0; i < nodeCount; i++) {
      cy -= segH;
      if (i % 2 === 0) {
        const bx = baseX + Math.sin(i * 0.5) * 6 * scale;
        [-1, 1].forEach(dir => {
          ctx.beginPath();
          ctx.moveTo(bx, cy);
          ctx.bezierCurveTo(
            bx + dir * 25 * scale, cy - 10 * scale,
            bx + dir * 40 * scale, cy - 20 * scale,
            bx + dir * 30 * scale, cy - 35 * scale
          );
          ctx.bezierCurveTo(
            bx + dir * 20 * scale, cy - 20 * scale,
            bx + dir * 8 * scale,  cy - 5 * scale,
            bx, cy
          );
          ctx.fill();
        });
      }
    }
    ctx.restore();
  }

  // ---------- 棋盘配色 ----------
  function boardPalette(boardSkinId) {
    if (boardSkinId === 'jade') {
      return { low: [157, 184, 154], high: [226, 242, 219], edge: 'rgba(70,100,70,0.75)' };
    } else if (boardSkinId === 'stone') {
      return { low: [142, 150, 144], high: [203, 210, 204], edge: 'rgba(80,92,86,0.75)' };
    }
    // 宣纸淡墨
    return { low: [207, 190, 156], high: [236, 226, 205], edge: 'rgba(90,72,45,0.8)' };
  }

  function rgbStr(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
  function rgbaStr(c, a) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

  // ---------- 棋盘（纯渐变 + 阴影，无网格）----------
  function boardBoundaryPath() {
    const W = Physics.W;
    const x0 = W.boardLeft, y0 = W.boardTop, span = W.boardSize;
    const p0 = project(x0, y0, 0);
    const p1 = project(x0 + span, y0, 0);
    const p2 = project(x0 + span, y0 + span, 0);
    const p3 = project(x0, y0 + span, 0);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    return { p0, p1, p2, p3 };
  }

  /** 光源在屏幕上的偏移（左上 → 阴影右下） */
  function boardLightOffset() {
    const len = worldToScreenLen(14);
    const lx = -Math.cos(cam.yaw - 0.35) * len;
    const ly = -Math.sin(cam.pitch) * len * 0.35 - len * 0.55;
    return { lx, ly, hx: -lx * 0.85, hy: -ly * 0.85 };
  }

  function drawBoardBase(pal, corners) {
    const { p0, p1, p2, p3 } = corners;
    const mid = [
      (pal.low[0] + pal.high[0]) / 2,
      (pal.low[1] + pal.high[1]) / 2,
      (pal.low[2] + pal.high[2]) / 2,
    ];
    const g = ctx.createLinearGradient(p0.x, p0.y, p2.x, p2.y);
    g.addColorStop(0, rgbStr(pal.high));
    g.addColorStop(0.45, rgbStr(mid));
    g.addColorStop(1, rgbStr(pal.low));
    ctx.fillStyle = g;
    ctx.fill();

    // 盘面轻微纸纹感：极淡径向明暗
    const cx = (p0.x + p2.x) / 2, cy = (p0.y + p2.y) / 2;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(p2.x - p0.x, p2.y - p0.y) * 0.55);
    rg.addColorStop(0, 'rgba(255,255,255,0.06)');
    rg.addColorStop(1, 'rgba(0,0,0,0.05)');
    ctx.fillStyle = rg;
    ctx.fill();
  }

  function drawBoardVignette(corners) {
    const { p0, p1, p2, p3 } = corners;
    const cx = (p0.x + p2.x) / 2, cy = (p0.y + p2.y) / 2;
    const r = Math.max(Math.hypot(p1.x - p0.x, p1.y - p0.y), Math.hypot(p3.x - p0.x, p3.y - p0.y)) * 0.72;
    const vg = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.82, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(35,25,12,0.14)');
    ctx.fillStyle = vg;
    ctx.fill();
  }

  function drawDomeRelief(pal) {
    const W = Physics.W;
    const { lx, ly, hx, hy } = boardLightOffset();
    const peak = project(W.centerX, W.centerY, surfaceHeight(W.centerX, W.centerY));
    const rx = worldToScreenLen(W.domeRadius * 0.96);
    const ry = rx * Math.max(Math.cos(cam.pitch), 0.28);

    // 丰腹落影（偏移投影阴影）
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const sh = ctx.createRadialGradient(
      peak.x + lx, peak.y + ly, rx * 0.08,
      peak.x + lx * 0.6, peak.y + ly * 0.6, rx * 1.02,
    );
    sh.addColorStop(0, 'rgba(55,40,20,0.38)');
    sh.addColorStop(0.55, 'rgba(80,60,35,0.16)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.ellipse(peak.x, peak.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = sh;
    ctx.fill();

    // 丰腹裙边暗角（隆起与平面过渡）
    const ao = ctx.createRadialGradient(peak.x, peak.y, rx * 0.42, peak.x, peak.y, rx * 1.08);
    ao.addColorStop(0, 'rgba(255,255,255,0)');
    ao.addColorStop(0.72, 'rgba(45,32,18,0.12)');
    ao.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ao;
    ctx.fill();
    ctx.restore();

    // 丰腹高光
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    const hi = [
      Math.min(255, pal.high[0] + 22),
      Math.min(255, pal.high[1] + 20),
      Math.min(255, pal.high[2] + 14),
    ];
    const hg = ctx.createRadialGradient(
      peak.x + hx, peak.y + hy, Math.max(2, rx * 0.03),
      peak.x, peak.y, rx * 0.78,
    );
    hg.addColorStop(0, rgbaStr(hi, 0.55));
    hg.addColorStop(0.35, 'rgba(255,248,232,0.22)');
    hg.addColorStop(0.7, 'rgba(255,240,215,0.05)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.ellipse(peak.x, peak.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = hg;
    ctx.fill();
    ctx.restore();

    // 顶心柔光
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const capR = worldToScreenLen(W.domeRadius * 0.1);
    const cap = ctx.createRadialGradient(peak.x + hx * 0.3, peak.y + hy * 0.3, 0, peak.x, peak.y, capR);
    cap.addColorStop(0, 'rgba(255,252,245,0.45)');
    cap.addColorStop(1, 'rgba(255,252,245,0)');
    ctx.beginPath();
    ctx.arc(peak.x, peak.y, capR, 0, Math.PI * 2);
    ctx.fillStyle = cap;
    ctx.fill();
    ctx.restore();
  }

  function drawCornerRelief() {
    const W = Physics.W;
    const cbr = W.cornerBulgeRadius;
    const { lx, ly, hx, hy } = boardLightOffset();
    const corners = [
      [W.boardLeft + cbr, W.boardTop + cbr],
      [W.boardRight - cbr, W.boardTop + cbr],
      [W.boardLeft + cbr, W.boardBottom - cbr],
      [W.boardRight - cbr, W.boardBottom - cbr],
    ];

    corners.forEach(([cx, cy]) => {
      const sp = project(cx, cy, surfaceHeight(cx, cy));
      const r = worldToScreenLen(cbr * 0.92);

      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      const sh = ctx.createRadialGradient(sp.x + lx * 0.5, sp.y + ly * 0.5, r * 0.05, sp.x + lx * 0.35, sp.y + ly * 0.35, r);
      sh.addColorStop(0, 'rgba(50,38,22,0.28)');
      sh.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = sh;
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      const hg = ctx.createRadialGradient(sp.x + hx * 0.4, sp.y + hy * 0.4, 0, sp.x, sp.y, r * 0.85);
      hg.addColorStop(0, 'rgba(255,246,228,0.32)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hg;
      ctx.fill();
      ctx.restore();
    });
  }

  function drawBoard(boardSkinId, lite) {
    const W = Physics.W;
    const pal = boardPalette(boardSkinId);
    const x0 = W.boardLeft, y0 = W.boardTop, span = W.boardSize;

    if (!lite) {
      ctx.save();
      const s0 = project(x0, y0, 0), s1 = project(x0 + span, y0, 0);
      const s2 = project(x0 + span, y0 + span, 0), s3 = project(x0, y0 + span, 0);
      ctx.beginPath();
      ctx.moveTo(s0.x + 5, s0.y + 12);
      ctx.lineTo(s1.x + 5, s1.y + 12);
      ctx.lineTo(s2.x + 5, s2.y + 12);
      ctx.lineTo(s3.x + 5, s3.y + 12);
      ctx.closePath();
      ctx.fillStyle = 'rgba(45,35,20,0.16)';
      ctx.filter = 'blur(10px)';
      ctx.fill();
      ctx.filter = 'none';
      ctx.restore();
    } else {
      ctx.save();
      const s0 = project(x0, y0, 0), s2 = project(x0 + span, y0 + span, 0);
      ctx.fillStyle = 'rgba(45,35,20,0.12)';
      ctx.fillRect(s0.x + 4, s0.y + 8, s2.x - s0.x, s2.y - s0.y + 6);
      ctx.restore();
    }

    ctx.save();
    const corners = boardBoundaryPath();
    drawBoardBase(pal, corners);

    ctx.save();
    boardBoundaryPath();
    ctx.clip();
    if (!lite) {
      drawBoardVignette(corners);
    }
    drawDomeRelief(pal);
    if (!lite) {
      drawCornerRelief();
    }
    ctx.restore();

    ctx.strokeStyle = pal.edge;
    ctx.lineWidth = Math.max(1.5, worldToScreenLen(1.6));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    boardBoundaryPath();
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 棋子渲染 ----------
  // 棋子侧壁颜色
  function pieceSideColor(skin, teamOrIsBlack) {
    if (typeof Teams !== 'undefined' && typeof teamOrIsBlack === 'string') {
      return Teams.getSideColors(teamOrIsBlack, skin);
    }
    const isBlack = teamOrIsBlack === true || teamOrIsBlack === 'black';
    if (isBlack) return ['rgba(40,40,40,1)', 'rgba(12,12,12,1)'];
    if (skin === 'jade')   return ['rgba(150,196,170,1)', 'rgba(110,156,134,1)'];
    if (skin === 'ivory')  return ['rgba(214,200,168,1)', 'rgba(176,160,124,1)'];
    return ['rgba(196,150,60,1)', 'rgba(140,100,30,1)'];   // lacquer
  }

  function pieceIsDark(teamId) {
    if (typeof Teams !== 'undefined') return Teams.isDarkTeam(teamId);
    return teamId === 'black';
  }

  function drawGeneralCrown(Pt, R, ellipseK) {
    ctx.save();
    const cy = Pt.y - R * 0.15 * ellipseK;
    const w = R * 0.72;
    ctx.fillStyle = 'rgba(220,175,40,0.95)';
    ctx.strokeStyle = 'rgba(120,80,10,0.9)';
    ctx.lineWidth = Math.max(1, worldToScreenLen(0.8));
    ctx.beginPath();
    ctx.moveTo(Pt.x - w * 0.5, cy + R * 0.12 * ellipseK);
    ctx.lineTo(Pt.x - w * 0.28, cy - R * 0.28 * ellipseK);
    ctx.lineTo(Pt.x, cy + R * 0.02 * ellipseK);
    ctx.lineTo(Pt.x + w * 0.28, cy - R * 0.28 * ellipseK);
    ctx.lineTo(Pt.x + w * 0.5, cy + R * 0.12 * ellipseK);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 棋子（3D：侧壁短柱 + 受俯仰压扁的顶面）
  function drawPiece(body, pieceSkinId, isSelected, isCurrentTeam, lite) {
    const W = Physics.W;
    const R0 = W.pieceRadius;
    const thick = R0 * 1.5;
    const px = body.position.x, py = body.position.y;
    const hs = surfaceHeight(px, py);
    const Pb = project(px, py, hs);            // 底面（接触盘面）
    const Pt = project(px, py, hs + thick);    // 顶面
    const R  = R0 * Pt.scale;
    const ellipseK = Math.max(Math.cos(cam.pitch), 0.28);
    const ry = R * ellipseK;
    const sideH = Pb.y - Pt.y;                  // 侧壁屏幕高度
    const teamId = body.gameTeam;
    const isBlack = pieceIsDark(teamId);

    ctx.save();

    // 接触阴影
    ctx.save();
    if (!lite) ctx.filter = 'blur(3px)';
    ctx.fillStyle = lite ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(Pb.x + R*0.12, Pb.y + ry*0.18, R*1.02, ry*1.02, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();

    // 侧壁（仅在有俯仰时可见）
    if (sideH > 1) {
      const [sl, sd] = pieceSideColor(pieceSkinId, teamId);
      const bandGrad = ctx.createLinearGradient(0, Pt.y, 0, Pb.y);
      bandGrad.addColorStop(0, sl);
      bandGrad.addColorStop(1, sd);
      // 底面椭圆
      ctx.fillStyle = sd;
      ctx.beginPath();
      ctx.ellipse(Pb.x, Pb.y, R, ry, 0, 0, Math.PI*2);
      ctx.fill();
      // 侧壁矩形带
      ctx.fillStyle = bandGrad;
      ctx.fillRect(Math.min(Pt.x,Pb.x) - R, Pt.y, R*2, sideH);
    }

    // 顶面（压扁圆）
    ctx.save();
    ctx.translate(Pt.x, Pt.y);
    ctx.scale(1, ellipseK);
    if (teamId === 'red') {
      drawTintedPiece(0, 0, R, ['#F0A898', '#D07060', '#A03828']);
    } else if (teamId === 'blue') {
      drawTintedPiece(0, 0, R, ['#A8C0F0', '#6890D0', '#4060A0']);
    } else if (pieceSkinId === 'jade')      drawJadePiece(0, 0, R, isBlack);
    else if (pieceSkinId === 'ivory') drawIvoryPiece(0, 0, R, isBlack);
    else                              drawLacquerPiece(0, 0, R, isBlack);
    ctx.restore();

    // 选中光环
    if (isSelected) {
      ctx.strokeStyle = 'rgba(240,200,60,0.85)';
      ctx.lineWidth = worldToScreenLen(2.5);
      ctx.setLineDash([worldToScreenLen(4), worldToScreenLen(3)]);
      ctx.beginPath();
      ctx.ellipse(Pt.x, Pt.y, R + worldToScreenLen(4), ry + worldToScreenLen(4)*ellipseK, 0, 0, Math.PI*2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (isCurrentTeam) {
      ctx.strokeStyle = 'rgba(240,200,60,0.32)';
      ctx.lineWidth = worldToScreenLen(1.2);
      ctx.beginPath();
      ctx.ellipse(Pt.x, Pt.y, R + worldToScreenLen(2), ry + worldToScreenLen(2)*ellipseK, 0, 0, Math.PI*2);
      ctx.stroke();
    }

    // 特殊棋子标记（趣味局）
    if (body.special === 'curve') {
      ctx.save();
      ctx.strokeStyle = 'rgba(40,160,180,0.95)';
      ctx.lineWidth = worldToScreenLen(1.6);
      ctx.lineCap = 'round';
      const rr = R * 0.62;
      ctx.beginPath();
      ctx.ellipse(Pt.x, Pt.y, rr, rr * ellipseK, 0, -0.5, Math.PI * 1.05);
      ctx.stroke();
      const a = Math.PI * 1.05;
      const ex = Pt.x + Math.cos(a) * rr, ey = Pt.y + Math.sin(a) * rr * ellipseK;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - worldToScreenLen(3.5), ey - worldToScreenLen(1));
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - worldToScreenLen(0.5), ey - worldToScreenLen(4));
      ctx.stroke();
      ctx.restore();
    } else if (body.special === 'speed') {
      ctx.save();
      ctx.strokeStyle = 'rgba(205,60,40,0.95)';
      ctx.lineWidth = worldToScreenLen(1.8);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const s = R * 0.5;
      for (let k = -1; k <= 1; k++) {
        const ox = k * s * 0.6;
        ctx.beginPath();
        ctx.moveTo(Pt.x + ox - s*0.45, Pt.y - s*0.5*ellipseK);
        ctx.lineTo(Pt.x + ox,          Pt.y);
        ctx.lineTo(Pt.x + ox - s*0.45, Pt.y + s*0.5*ellipseK);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (body.isGeneral) {
      drawGeneralCrown(Pt, R, ellipseK);
    }

    ctx.restore();
  }

  function drawTintedPiece(cx, cy, R, stops) {
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 0, cx, cy, R);
    g.addColorStop(0, stops[0]);
    g.addColorStop(0.5, stops[1]);
    g.addColorStop(1, stops[2]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    const hl = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, 0, cx - R * 0.15, cy - R * 0.15, R * 0.5);
    hl.addColorStop(0, 'rgba(255,255,255,0.45)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawJadePiece(cx, cy, R, isBlack) {
    const g = ctx.createRadialGradient(cx - R*0.35, cy - R*0.35, 0, cx, cy, R);
    if (isBlack) {
      g.addColorStop(0, '#5C7A58');
      g.addColorStop(0.4, '#3A5538');
      g.addColorStop(0.8, '#1E3020');
      g.addColorStop(1,   '#0E1E10');
    } else {
      g.addColorStop(0, '#F2FBF5');
      g.addColorStop(0.4, '#CCEADC');
      g.addColorStop(0.8, '#A8D4C0');
      g.addColorStop(1,   '#8EBBA8');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // 内纹（玉石纹路）
    ctx.strokeStyle = isBlack ? 'rgba(80,120,70,0.3)' : 'rgba(200,240,220,0.4)';
    ctx.lineWidth = worldToScreenLen(0.8);
    ctx.beginPath();
    ctx.arc(cx + R*0.1, cy - R*0.1, R * 0.4, 0.2, 2.1);
    ctx.stroke();

    // 高光
    const hl = ctx.createRadialGradient(cx - R*0.4, cy - R*0.35, 0, cx - R*0.2, cy - R*0.2, R*0.55);
    hl.addColorStop(0, 'rgba(255,255,255,0.55)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawIvoryPiece(cx, cy, R, isBlack) {
    const g = ctx.createRadialGradient(cx - R*0.3, cy - R*0.3, 0, cx, cy, R);
    if (isBlack) {
      g.addColorStop(0, '#4A3020');
      g.addColorStop(0.5, '#2A1808');
      g.addColorStop(1,   '#140A02');
    } else {
      g.addColorStop(0, '#FFFBF2');
      g.addColorStop(0.5, '#F5EED8');
      g.addColorStop(1,   '#E8DEC0');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // 年轮纹（象牙/木质纹理）
    ctx.strokeStyle = isBlack ? 'rgba(100,60,20,0.15)' : 'rgba(200,180,130,0.25)';
    ctx.lineWidth = worldToScreenLen(0.6);
    for (let rr = R * 0.3; rr < R * 0.9; rr += R * 0.25) {
      ctx.beginPath();
      ctx.ellipse(cx + R*0.05, cy, rr, rr * 0.85, 0.3, 0, Math.PI * 2);
      ctx.stroke();
    }

    const hl = ctx.createRadialGradient(cx - R*0.35, cy - R*0.35, 0, cx - R*0.15, cy - R*0.15, R*0.5);
    hl.addColorStop(0, 'rgba(255,255,240,0.6)');
    hl.addColorStop(1, 'rgba(255,255,240,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLacquerPiece(cx, cy, R, isBlack) {
    const g = ctx.createRadialGradient(cx - R*0.3, cy - R*0.3, 0, cx, cy, R);
    if (isBlack) {
      g.addColorStop(0, '#303030');
      g.addColorStop(0.5, '#101010');
      g.addColorStop(1,   '#050505');
    } else {
      g.addColorStop(0, '#F0D890');
      g.addColorStop(0.4, '#D4A840');
      g.addColorStop(0.8, '#B88020');
      g.addColorStop(1,   '#8A5C10');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // 金丝纹路
    const goldColor = isBlack ? 'rgba(200,160,40,0.35)' : 'rgba(255,220,100,0.5)';
    ctx.strokeStyle = goldColor;
    ctx.lineWidth = worldToScreenLen(0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.6, 0.5, 2.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.75, 1.5, 4.2);
    ctx.stroke();

    const hl = ctx.createRadialGradient(cx - R*0.3, cy - R*0.3, 0, cx - R*0.1, cy - R*0.1, R*0.6);
    hl.addColorStop(0, 'rgba(255,255,255,0.45)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- 障碍物（石山）----------
  function drawObstacle(body) {
    const pos = worldToScreen(body.position.x, body.position.y);
    const R   = Physics.W.obstacleRadius * pos.scale;

    ctx.save();
    ctx.shadowBlur = worldToScreenLen(5);
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowOffsetX = worldToScreenLen(2);
    ctx.shadowOffsetY = worldToScreenLen(2);

    const g = ctx.createRadialGradient(pos.x - R*0.2, pos.y - R*0.2, 0, pos.x, pos.y, R);
    g.addColorStop(0, '#A8B0B0');
    g.addColorStop(0.5, '#7A8585');
    g.addColorStop(0.9, '#5A6565');
    g.addColorStop(1, '#4A5555');
    ctx.fillStyle = g;

    // 不规则石形（多边形近似）
    ctx.beginPath();
    const verts = 7;
    for (let i = 0; i < verts; i++) {
      const angle = (i / verts) * Math.PI * 2 - 0.5;
      // 用 body.id 做 seed 让每块石头形状固定
      const rand = ((body.id * 13 + i * 7) % 10) / 10;
      const r = R * (0.75 + rand * 0.35);
      const x = pos.x + Math.cos(angle) * r;
      const y = pos.y + Math.sin(angle) * r * 0.75;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // 石纹线
    ctx.strokeStyle = 'rgba(90,100,100,0.4)';
    ctx.lineWidth = worldToScreenLen(0.8);
    ctx.beginPath();
    ctx.moveTo(pos.x - R*0.3, pos.y - R*0.1);
    ctx.lineTo(pos.x + R*0.2, pos.y + R*0.25);
    ctx.moveTo(pos.x - R*0.1, pos.y + R*0.2);
    ctx.lineTo(pos.x + R*0.35, pos.y - R*0.15);
    ctx.stroke();

    ctx.restore();
  }

  // ---------- 趣味局：陷洞（盘面凹陷的暗孔）----------
  function drawHole(h) {
    const sp = project(h.x, h.y, surfaceHeight(h.x, h.y));
    const R = h.r * sp.scale;
    const ry = R * Math.max(Math.cos(cam.pitch), 0.28);
    ctx.save();
    const g = ctx.createRadialGradient(sp.x, sp.y - ry*0.2, 0, sp.x, sp.y, R);
    g.addColorStop(0, 'rgba(0,0,0,0.95)');
    g.addColorStop(0.65, 'rgba(12,12,14,0.9)');
    g.addColorStop(1, 'rgba(40,36,30,0.45)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, R, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(28,22,16,0.6)';
    ctx.lineWidth = worldToScreenLen(1.5);
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, R, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 趣味局：反弹墙（贴边界的高弹矮墙）----------
  function drawWall(body) {
    const len = body.wallLen, horiz = body.wallHorizontal;
    const cx = body.position.x, cy = body.position.y, half = len / 2;
    const ax = horiz ? cx - half : cx, ay = horiz ? cy : cy - half;
    const bx = horiz ? cx + half : cx, by = horiz ? cy : cy + half;
    const H = 18;
    const ha = surfaceHeight(ax, ay), hb = surfaceHeight(bx, by);
    const a0 = project(ax, ay, ha),     b0 = project(bx, by, hb);
    const a1 = project(ax, ay, ha + H), b1 = project(bx, by, hb + H);

    ctx.save();
    // 侧面
    ctx.beginPath();
    ctx.moveTo(a0.x, a0.y); ctx.lineTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y); ctx.lineTo(a1.x, a1.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(118,108,92,0.92)';
    ctx.fill();
    // 顶棱
    ctx.strokeStyle = 'rgba(235,228,210,0.85)';
    ctx.lineWidth = worldToScreenLen(2.4);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.stroke();
    // 弹性青光底沿
    ctx.strokeStyle = 'rgba(70,165,185,0.65)';
    ctx.lineWidth = worldToScreenLen(1.4);
    ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(b0.x, b0.y); ctx.stroke();
    ctx.restore();
  }

  // ---------- 趣味局：固定阻块（弱反弹方块）----------
  function drawBlock(body) {
    const s = body.blockSize, H = 13, ang = body.angle;
    const cx = body.position.x, cy = body.position.y;
    const hh = surfaceHeight(cx, cy);
    const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx, sy]) => {
      const lx = sx * s / 2, ly = sy * s / 2;
      return {
        wx: cx + lx * Math.cos(ang) - ly * Math.sin(ang),
        wy: cy + lx * Math.sin(ang) + ly * Math.cos(ang),
      };
    });
    const base = corners.map(c => project(c.wx, c.wy, hh));
    const top  = corners.map(c => project(c.wx, c.wy, hh + H));

    ctx.save();
    // 接触阴影
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    base.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.fill();
    // 侧壁
    ctx.fillStyle = 'rgba(92,78,62,0.96)';
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      ctx.beginPath();
      ctx.moveTo(base[i].x, base[i].y); ctx.lineTo(base[j].x, base[j].y);
      ctx.lineTo(top[j].x, top[j].y);   ctx.lineTo(top[i].x, top[i].y);
      ctx.closePath(); ctx.fill();
    }
    // 顶面
    ctx.fillStyle = 'rgba(150,131,104,0.97)';
    ctx.beginPath();
    top.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(58,44,30,0.55)';
    ctx.lineWidth = worldToScreenLen(1);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 拖拽瞄准线（毛笔风格）----------
  function drawAimLine(pieceBody, dragWorldX, dragWorldY, strength) {
    const pp = worldToScreen(pieceBody.position.x, pieceBody.position.y);
    // 弹出方向：棋子 → (棋子 - 拖拽点) 的反向
    const dx = pieceBody.position.x - dragWorldX;
    const dy = pieceBody.position.y - dragWorldY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;

    const nx = dx / dist;
    const ny = dy / dist;

    const W = Physics.W;
    const maxDragDist = 80;  // 世界单位
    // 瞄准箭头显著缩短：仅给出方向提示，不暴露力度行程，增加难度
    const aimLen = Math.min(W.pieceRadius * 2.4 + Math.min(dist, maxDragDist) * 0.18, 36);

    const aimEndWorld = {
      x: pieceBody.position.x + nx * aimLen,
      y: pieceBody.position.y + ny * aimLen,
    };
    const aimEnd = worldToScreen(aimEndWorld.x, aimEndWorld.y);

    const dragPt = worldToScreen(dragWorldX, dragWorldY);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 橡皮筋（后拉方向）
    ctx.strokeStyle = 'rgba(80,40,10,0.5)';
    ctx.lineWidth = worldToScreenLen(1.5);
    ctx.setLineDash([worldToScreenLen(4), worldToScreenLen(3)]);
    ctx.beginPath();
    ctx.moveTo(pp.x, pp.y);
    ctx.lineTo(dragPt.x, dragPt.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 瞄准线（毛笔墨迹，由粗到细）
    const segments = 10;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const p0x = pp.x + (aimEnd.x - pp.x) * t0;
      const p0y = pp.y + (aimEnd.y - pp.y) * t0;
      const p1x = pp.x + (aimEnd.x - pp.x) * t1;
      const p1y = pp.y + (aimEnd.y - pp.y) * t1;

      const alpha = 0.65 * (1 - t0 * 0.6);
      const w = worldToScreenLen(2.5 * strength * (1 - t0 * 0.5) + 0.5);

      ctx.strokeStyle = `rgba(40,20,5,${alpha})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.lineTo(p1x, p1y);
      ctx.stroke();
    }

    // 箭头
    const headLen = worldToScreenLen(10);
    const angle = Math.atan2(aimEnd.y - pp.y, aimEnd.x - pp.x);
    ctx.strokeStyle = 'rgba(60,30,10,0.7)';
    ctx.lineWidth = worldToScreenLen(1.5);
    ctx.beginPath();
    ctx.moveTo(aimEnd.x, aimEnd.y);
    ctx.lineTo(aimEnd.x - headLen * Math.cos(angle - 0.45), aimEnd.y - headLen * Math.sin(angle - 0.45));
    ctx.moveTo(aimEnd.x, aimEnd.y);
    ctx.lineTo(aimEnd.x - headLen * Math.cos(angle + 0.45), aimEnd.y - headLen * Math.sin(angle + 0.45));
    ctx.stroke();

    ctx.restore();
  }

  // ---------- 轨迹预测（短段虚线）----------
  function drawTrajectory(points) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(80,50,10,0.25)';
    ctx.lineWidth = worldToScreenLen(1.2);
    ctx.setLineDash([worldToScreenLen(3), worldToScreenLen(4)]);
    ctx.lineCap = 'round';

    ctx.beginPath();
    const p0 = worldToScreen(points[0].x, points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = worldToScreen(points[i].x, points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------- 粒子系统（碰撞尘埃）----------
  function addCollisionParticles(wx, wy, intensity, lite) {
    if (lite && particles.length > 60) return;
    const count = lite
      ? Math.floor(2 + intensity * 3)
      : Math.floor(4 + intensity * 6);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 40 * intensity;
      particles.push({
        wx: wx + (Math.random() - 0.5) * 8,
        wy: wy + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        size: 1.5 + Math.random() * 2.5,
        color: `rgba(${150 + Math.floor(Math.random()*80)},${120+Math.floor(Math.random()*60)},${80+Math.floor(Math.random()*40)}`,
      });
    }
  }

  function updateAndDrawParticles(dt) {
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
      p.wx += p.vx * dt;
      p.wy += p.vy * dt;
      p.vx *= 0.88;
      p.vy *= 0.88;
      p.life -= dt * 2.5;

      // life 递减后可能为负，半径必须非负，否则 ctx.arc 抛 IndexSizeError
      if (p.life <= 0) return;
      const r = worldToScreenLen(p.size * p.life);
      if (r <= 0) return;
      const sp = worldToScreen(p.wx, p.wy);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `${p.color},${p.life * 0.7})`;
      ctx.fill();
    });
  }

  // ---------- 落盘动画 ----------
  let fallAnimations = [];
  function addFallAnimation(wx, wy, team) {
    fallAnimations.push({ wx, wy, life: 1, team });
  }

  function drawFallAnimations(dt) {
    fallAnimations = fallAnimations.filter(f => f.life > 0);
    fallAnimations.forEach(f => {
      f.life -= dt * 1.5;
      const sp = worldToScreen(f.wx, f.wy);
      const alpha = f.life;
      const r = worldToScreenLen(Physics.W.pieceRadius * (1 + (1 - f.life) * 0.5));

      ctx.save();
      ctx.strokeStyle = f.team === 'black'
        ? `rgba(30,60,30,${alpha * 0.6})`
        : `rgba(200,230,210,${alpha * 0.6})`;
      ctx.lineWidth = worldToScreenLen(2);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
  }

  // ---------- 布局阶段合法区域提示 ----------
  function drawLayoutZone(team, matchMode) {
    const W = Physics.W;
    let zoneTop, zoneBottom, zoneLeft, zoneRight;

    if (matchMode === '4FFA' && typeof Teams !== 'undefined') {
      const z = Teams.getLayoutZone(team, W);
      zoneTop = z.yMin;
      zoneBottom = z.yMax;
      zoneLeft = z.xMin;
      zoneRight = z.xMax;
    } else if (team === 'black') {
      zoneTop = W.boardTop + W.boardSize * 0.55;
      zoneBottom = W.boardBottom;
      zoneLeft = W.boardLeft;
      zoneRight = W.boardRight;
    } else {
      zoneTop = W.boardTop;
      zoneBottom = W.boardTop + W.boardSize * 0.45;
      zoneLeft = W.boardLeft;
      zoneRight = W.boardRight;
    }

    const pts = [];
    const N = 10;
    const lerp = (a, b, t) => a + (b - a) * t;
    for (let i = 0; i <= N; i++) pts.push(worldToScreen(lerp(zoneLeft, zoneRight, i/N), zoneTop));
    for (let i = 1; i <= N; i++) pts.push(worldToScreen(zoneRight, lerp(zoneTop, zoneBottom, i/N)));
    for (let i = 1; i <= N; i++) pts.push(worldToScreen(lerp(zoneRight, zoneLeft, i/N), zoneBottom));
    for (let i = 1; i <= N; i++) pts.push(worldToScreen(zoneLeft, lerp(zoneBottom, zoneTop, i/N)));

    const style = (matchMode === '4FFA' && typeof Teams !== 'undefined')
      ? Teams.getLayoutStyle(team)
      : {
        fill: team === 'black' ? 'rgba(30,50,30,0.12)' : 'rgba(220,240,220,0.15)',
        stroke: team === 'black' ? 'rgba(40,80,40,0.4)' : 'rgba(180,220,180,0.5)',
      };

    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = style.fill;
    ctx.fill();

    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = worldToScreenLen(1.5);
    ctx.setLineDash([worldToScreenLen(5), worldToScreenLen(4)]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---------- 回放文字覆盖 ----------
  function drawReplayOverlay(replayData) {
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.fillStyle = 'rgba(243,235,216,0.9)';
    ctx.fillRect(0, 0, W, H);

    const pw = Math.min(W * 0.7, 500);
    const ph = Math.min(H * 0.75, 480);
    const px = W / 2 - pw / 2, py = H / 2 - ph / 2;

    ctx.fillStyle = 'rgba(250,242,220,0.97)';
    roundRect(px, py, pw, ph, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,140,55,0.8)';
    ctx.lineWidth = 2;
    roundRect(px, py, pw, ph, 10);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#2A1A08';
    ctx.font = `bold ${Math.round(pw * 0.1)}px "Noto Serif SC", serif`;
    ctx.fillText('本局回放', W / 2, py + 56);

    ctx.strokeStyle = 'rgba(160,120,50,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 30, py + 72); ctx.lineTo(px + pw - 30, py + 72);
    ctx.stroke();

    ctx.font = `${Math.round(pw * 0.05)}px "Noto Serif SC", serif`;
    ctx.fillStyle = '#5A3820';
    const maxShow = Math.min(replayData.length, 10);
    for (let i = 0; i < maxShow; i++) {
      const r = replayData[i];
      const team = r.team === 'black' ? '黑方' : '白方';
      const strength = Math.round(Math.hypot(r.fx, r.fy) / 0.025 * 100);
      const angle = Math.round(Math.atan2(r.fy, r.fx) * 180 / Math.PI);
      ctx.fillText(
        `第 ${i + 1} 弹 — ${team} · 力度 ${strength}% · 方位 ${angle}°`,
        W / 2, py + 98 + i * 28
      );
    }
    if (replayData.length === 0) {
      ctx.fillText('（无记录）', W / 2, py + 130);
    }

    ctx.fillStyle = '#8A6020';
    ctx.font = `${Math.round(pw * 0.048)}px "Noto Serif SC", serif`;
    ctx.fillText('点击任意处返回', W / 2, py + ph - 32);
    ctx.restore();
  }

  // ---------- 主渲染入口 ----------
  function render(gameState) {
    updateBaseTransform();
    updateCamera();
    const dpr = canvas._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.clearRect(0, 0, viewW(), viewH());

    drawBackground(gameState.boardSkin);

    const dt = gameState.dt || 0.016;
    const liteRender = gameState.mode === 'ONLINE' && gameState.subPhase === 'moving';

    drawBoard(gameState.boardSkin, liteRender);

    // 布局区域
    if (gameState.phase === 'layout') {
      const layoutTeam = gameState.mode === 'ONLINE' ? gameState.onlineMyTeam : gameState.layoutTeam;
      drawLayoutZone(layoutTeam, gameState.matchMode);
    }

    // 趣味局：陷洞贴在盘面上，需在棋子之前绘制
    if (Physics.getHoles) {
      Physics.getHoles().forEach(h => drawHole(h));
    }

    // 棋子与障碍物：按深度从远到近排序后绘制（画家算法）
    const drawables = [];
    Physics.getObstacles().forEach(obs => {
      const sp = project(obs.position.x, obs.position.y, surfaceHeight(obs.position.x, obs.position.y));
      drawables.push({ kind: 'obs', body: obs, depth: sp.depth });
    });
    if (Physics.getWalls) {
      Physics.getWalls().forEach(w => {
        const sp = project(w.position.x, w.position.y, surfaceHeight(w.position.x, w.position.y));
        drawables.push({ kind: 'wall', body: w, depth: sp.depth });
      });
    }
    if (Physics.getBlocks) {
      Physics.getBlocks().forEach(b => {
        const sp = project(b.position.x, b.position.y, surfaceHeight(b.position.x, b.position.y));
        drawables.push({ kind: 'block', body: b, depth: sp.depth });
      });
    }
    Physics.getPieces().forEach(body => {
      if (gameState.mode === 'ONLINE' && gameState.onlineBlindLayout
          && gameState.phase === 'layout' && body.gameTeam !== gameState.onlineMyTeam) {
        return;
      }
      const sp = project(body.position.x, body.position.y, surfaceHeight(body.position.x, body.position.y));
      drawables.push({ kind: 'piece', body, depth: sp.depth });
    });
    drawables.sort((a, b) => a.depth - b.depth);
    drawables.forEach(it => {
      if (it.kind === 'obs') { drawObstacle(it.body); return; }
      if (it.kind === 'wall') { drawWall(it.body); return; }
      if (it.kind === 'block') { drawBlock(it.body); return; }
      const body = it.body;
      const isSelected = body === gameState.selectedPiece;
      const isCurrentTeam = body.gameTeam === gameState.currentTurn && gameState.phase === 'playing';
      drawPiece(body, gameState.pieceSkin, isSelected, isCurrentTeam, liteRender);
    });

    // 瞄准线（仅短箭头，不显示轨迹预测，增加难度）
    if (gameState.isDragging && gameState.selectedPiece && gameState.dragWorldPos) {
      const dx = gameState.selectedPiece.position.x - gameState.dragWorldPos.x;
      const dy = gameState.selectedPiece.position.y - gameState.dragWorldPos.y;
      const dist = Math.hypot(dx, dy);
      const strength = Math.min(dist / 80, 1);
      drawAimLine(gameState.selectedPiece, gameState.dragWorldPos.x, gameState.dragWorldPos.y, strength);
    }

    // 粒子
    updateAndDrawParticles(dt);
    drawFallAnimations(dt);
  }

  return {
    init,
    render,
    updateBaseTransform,
    worldToScreen,
    screenToWorld,
    screenToWorldPlane,
    worldToScreenLen,
    project,
    surfaceHeight,
    pickPiece,
    rotateBy,
    resetView,
    setViewportInsets,
    setFFAViewMode,
    setCameraOverview,
    setCameraForFFA,
    setCameraForTurn,
    setCameraFollow,
    addCollisionParticles,
    addFallAnimation,
    drawLayoutZone,
    cam,
  };
})();
