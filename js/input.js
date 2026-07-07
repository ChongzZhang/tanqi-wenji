// 《幽寂弹棋》输入处理 — 左键/单指始终拖棋子弹射，右键/双指始终旋转视角（鼠标 + 触屏）

const Input = (() => {
  let canvas;

  // 弹射拖拽
  let selectedPiece = null;
  let dragCurrentWorld = null;
  // 视角旋转
  let rotating = false;
  let lastSx = 0, lastSy = 0;
  // 当前手势：null | 'flick' | 'rotate'
  let mode = null;

  const MAX_DRAG_DIST = 80;     // 世界单位
  const MAX_FORCE     = 0.025;
  const ROT_YAW   = 0.007;      // 每像素偏航
  const ROT_PITCH = 0.006;      // 每像素俯仰
  const MIN_AIM_DIST = 16;      // 贴边时预置最小瞄准距离（世界单位）
  const MIN_FLING_DIST = 4;
  const MIN_FLING_DIST_EDGE = 2.5;

  let _onFling       = null;
  let _onPieceSelect = null;
  let _onPlacement   = null;    // 布局阶段放置棋子回调 (wx, wy)

  let _lastTapAt = 0;
  let _globalDragBound = false;

  function init(c) {
    canvas = c;
    c.addEventListener('mousedown',  onMouseDown,  { passive: false });
    c.addEventListener('mousemove',  onMouseMove,  { passive: true  });
    c.addEventListener('mouseup',    onMouseUp,    { passive: false });
    c.addEventListener('mouseleave', onMouseLeave, { passive: true  });
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    c.addEventListener('touchmove',  onTouchMove,  { passive: false });
    c.addEventListener('touchend',   onTouchEnd,   { passive: false });
    // 右键旋转：屏蔽右键菜单
    c.addEventListener('contextmenu', e => e.preventDefault());
    // 双击复位视角
    c.addEventListener('dblclick', () => Renderer.resetView());
  }

  function bindGlobalDrag() {
    if (_globalDragBound) return;
    _globalDragBound = true;
    document.addEventListener('touchmove', onDocTouchMove, { passive: false });
    document.addEventListener('touchend', onDocTouchEnd, { passive: false });
    document.addEventListener('touchcancel', onDocTouchEnd, { passive: false });
  }

  function unbindGlobalDrag() {
    if (!_globalDragBound) return;
    _globalDragBound = false;
    document.removeEventListener('touchmove', onDocTouchMove);
    document.removeEventListener('touchend', onDocTouchEnd);
    document.removeEventListener('touchcancel', onDocTouchEnd);
  }

  function screenFromTouch(t) {
    const rect = canvas.getBoundingClientRect();
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function onDocTouchMove(e) {
    if (mode !== 'flick' || !selectedPiece) return;
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    processMove(screenFromTouch(t));
  }

  function onDocTouchEnd(e) {
    if (mode !== 'flick') return;
    e.preventDefault();
    release();
  }

  // ——— 坐标 ———
  function evtScreen(e) {
    const rect = canvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  }

  function edgeDistToBoard(px, py) {
    const ww = Physics.W;
    return Math.min(
      px - ww.boardLeft,
      ww.boardRight - px,
      py - ww.boardTop,
      ww.boardBottom - py
    );
  }

  function isNearBoardEdge(px, py) {
    return edgeDistToBoard(px, py) < Physics.W.pieceRadius + 10;
  }

  function clampDrag(wx, wy, px, py) {
    const dx = wx - px, dy = wy - py;
    const d  = Math.hypot(dx, dy);
    if (d > MAX_DRAG_DIST) {
      return { x: px + (dx / d) * MAX_DRAG_DIST, y: py + (dy / d) * MAX_DRAG_DIST };
    }
    return { x: wx, y: wy };
  }

  /** 贴边棋子：预置向盘心方向的拖拽点，避免屏幕边缘没有瞄准空间 */
  function ensureAimRoom(wx, wy, px, py) {
    let drag = clampDrag(wx, wy, px, py);
    let dx = drag.x - px;
    let dy = drag.y - py;
    let d = Math.hypot(dx, dy);
    if (d >= MIN_AIM_DIST && !isNearBoardEdge(px, py)) return drag;

    const ww = Physics.W;
    if (isNearBoardEdge(px, py) || d < 1) {
      let ix = ww.centerX - px;
      let iy = ww.centerY - py;
      const il = Math.hypot(ix, iy) || 1;
      drag = clampDrag(
        px - (ix / il) * MIN_AIM_DIST,
        py - (iy / il) * MIN_AIM_DIST,
        px, py
      );
      return drag;
    }

    if (d < MIN_AIM_DIST) {
      const dl = d || 1;
      drag = clampDrag(px + (dx / dl) * MIN_AIM_DIST, py + (dy / dl) * MIN_AIM_DIST, px, py);
    }
    return drag;
  }

  // ——— 按下 ———
  function onMouseDown(e) {
    e.preventDefault();
    const sc = evtScreen(e);
    processDown(sc, e.button === 2);   // 右键 = 旋转
  }

  function onTouchStart(e) {
    e.preventDefault();
    const sc = evtScreen(e);
    const twoFinger = e.touches && e.touches.length >= 2;
    const now = Date.now();
    const gs = Game.state;

    // 布局 / 行棋阶段连点勿触发双击复位视角
    if (!twoFinger && gs.phase === 'layout' && _onPlacement) {
      _lastTapAt = now;
      processDown(sc, false);
      return;
    }
    if (!twoFinger && gs.phase === 'playing' && gs.subPhase === 'waiting') {
      _lastTapAt = now;
      processDown(sc, false);
      return;
    }

    if (now - _lastTapAt < 300) {
      Renderer.resetView();
      _lastTapAt = 0;
      return;
    }
    _lastTapAt = now;
    processDown(sc, twoFinger);
  }

  function processDown(sc, forceRotate) {
    Audio.resume();

    // 布局阶段：左键/单指点击盘面放置棋子
    if (!forceRotate && Game.state.phase === 'layout' && _onPlacement) {
      const w = Renderer.screenToWorldPlane(sc.x, sc.y);
      _onPlacement(w.x, w.y);
      return;
    }

    // 左键（非强制旋转）始终用于拖动棋子；命中己方棋子 → 弹射
    if (!forceRotate && Game.state.phase === 'playing' && Game.state.subPhase === 'waiting') {
      const gs = Game.state;
      if (gs.mode === 'ONLINE' && gs.currentTurn !== gs.onlineMyTeam) return;
      const pickTeam = gs.mode === 'ONLINE' ? gs.onlineMyTeam : gs.currentTurn;
      const piece = Renderer.pickPiece(sc.x, sc.y, pickTeam);
      if (piece) {
        selectedPiece = piece;
        mode = 'flick';
        bindGlobalDrag();
        const w = Renderer.screenToWorldPlane(sc.x, sc.y);
        dragCurrentWorld = ensureAimRoom(
          w.x, w.y,
          piece.position.x, piece.position.y
        );
        if (_onPieceSelect) _onPieceSelect(piece);
      }
      return;
    }

    // 仅右键 / 双指 → 旋转视角；左键空白处不旋转
    if (!forceRotate) return;
    mode = 'rotate';
    rotating = true;
    lastSx = sc.x; lastSy = sc.y;
  }

  // ——— 移动 ———
  function onMouseMove(e) { processMove(evtScreen(e)); }
  function onTouchMove(e) {
    e.preventDefault();
    processMove(evtScreen(e));
  }

  function processMove(sc) {
    if (mode === 'flick' && selectedPiece) {
      const w = Renderer.screenToWorldPlane(sc.x, sc.y);
      const px = selectedPiece.position.x;
      const py = selectedPiece.position.y;
      let drag = clampDrag(w.x, w.y, px, py);
      const d = Math.hypot(drag.x - px, drag.y - py);
      if (isNearBoardEdge(px, py) && d < MIN_AIM_DIST) {
        drag = ensureAimRoom(w.x, w.y, px, py);
      }
      dragCurrentWorld = drag;
    } else if (mode === 'rotate' && rotating) {
      const dx = sc.x - lastSx, dy = sc.y - lastSy;
      lastSx = sc.x; lastSy = sc.y;
      Renderer.rotateBy(dx * ROT_YAW, dy * ROT_PITCH);
    }
  }

  // ——— 抬起 ———
  function onMouseUp()    { release(); }
  function onTouchEnd(e)  {
    if (mode === 'flick') return;
    e.preventDefault();
    release();
  }
  function onMouseLeave() { if (mode === 'rotate') release(); }

  function release() {
    if (mode === 'flick' && selectedPiece && dragCurrentWorld) {
      const piece = selectedPiece;
      const drag  = dragCurrentWorld;
      const dx = piece.position.x - drag.x;
      const dy = piece.position.y - drag.y;
      const d  = Math.hypot(dx, dy);
      const minDist = isNearBoardEdge(piece.position.x, piece.position.y)
        ? MIN_FLING_DIST_EDGE
        : MIN_FLING_DIST;
      if (d > minDist) {
        const strength = Math.min(d / MAX_DRAG_DIST, 1);
        const fx = (dx / d) * strength * MAX_FORCE;
        const fy = (dy / d) * strength * MAX_FORCE;
        if (_onFling) _onFling(piece, fx, fy, strength);
      }
    }
    reset();
  }

  function reset() {
    mode = null;
    rotating = false;
    selectedPiece = null;
    dragCurrentWorld = null;
    unbindGlobalDrag();
  }

  // ——— 布局放置开关 ———
  function enablePlacement(team, cb) {
    _onPlacement = (wx, wy) => {
      const ww = Physics.W;
      let zTop, zBot;
      if (team === 'black') {
        zTop = ww.boardTop + ww.boardSize * 0.55;
        zBot = ww.boardBottom - 12;
      } else {
        zTop = ww.boardTop + 12;
        zBot = ww.boardTop + ww.boardSize * 0.45;
      }
      if (wx > ww.boardLeft + 12 && wx < ww.boardRight - 12 &&
          wy > zTop && wy < zBot) {
        cb(wx, wy);
      }
    };
  }

  function disablePlacement() {
    _onPlacement = null;
  }

  // ——— 状态导出 ———
  function getState() {
    return {
      isDragging: mode === 'flick',
      selectedPiece: mode === 'flick' ? selectedPiece : null,
      dragWorldPos: mode === 'flick' ? dragCurrentWorld : null,
    };
  }

  return {
    init,
    getState,
    enablePlacement,
    disablePlacement,
    reset,
    set onFling(cb)       { _onFling       = cb; },
    set onPieceSelect(cb) { _onPieceSelect  = cb; },
  };
})();
