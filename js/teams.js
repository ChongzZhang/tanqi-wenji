// 四方乱战 — 队伍配置与四角布局区

const Teams = (() => {
  const TURN_ORDER = ['white', 'black', 'red', 'blue'];
  const LAYOUT_ORDER = ['white', 'black', 'red', 'blue'];
  const AI_TEAMS = ['black', 'red', 'blue'];
  const HUMAN_TEAM = 'white';
  const PIECES_PER_TEAM = 6;
  /** 四国混战：边界反弹墙总长 +30%，阻块等 +40%，障碍 ×3，陷洞不变 */
  const FFA_WALL_LEN_MULT = 1.3;
  const FFA_OBJECT_MULT = 1.4;
  const FFA_OBSTACLE_MULT = 3;
  /** 四国混战 AI 固定使用大师（id=2） */
  const MASTER_AI_LEVEL = 2;
  /** 菱形视角偏航：白方(左下象限)始终在屏幕下方 */
  const FFA_CAMERA_YAW = -Math.PI / 4;

  const DEFS = {
    black: {
      name: '黑方',
      zone: 'tl',
      layoutFill: 'rgba(30,50,30,0.12)',
      layoutStroke: 'rgba(40,80,40,0.45)',
      sideLight: ['rgba(40,40,40,1)', 'rgba(150,196,170,1)', 'rgba(214,200,168,1)', 'rgba(196,150,60,1)'],
      sideDark:  ['rgba(12,12,12,1)', 'rgba(110,156,134,1)', 'rgba(176,160,124,1)', 'rgba(140,100,30,1)'],
      darkPiece: true,
    },
    red: {
      name: '红方',
      zone: 'tr',
      layoutFill: 'rgba(120,40,30,0.12)',
      layoutStroke: 'rgba(160,60,40,0.5)',
      sideLight: ['rgba(200,90,70,1)', 'rgba(200,120,100,1)', 'rgba(220,170,150,1)', 'rgba(190,100,60,1)'],
      sideDark:  ['rgba(130,45,35,1)', 'rgba(150,70,55,1)', 'rgba(170,120,100,1)', 'rgba(140,70,40,1)'],
      darkPiece: true,
    },
    blue: {
      name: '蓝方',
      zone: 'br',
      layoutFill: 'rgba(30,50,100,0.12)',
      layoutStroke: 'rgba(50,80,150,0.5)',
      sideLight: ['rgba(90,130,200,1)', 'rgba(120,160,210,1)', 'rgba(170,190,230,1)', 'rgba(100,140,200,1)'],
      sideDark:  ['rgba(45,75,140,1)', 'rgba(70,100,160,1)', 'rgba(120,140,190,1)', 'rgba(60,90,150,1)'],
      darkPiece: true,
    },
    white: {
      name: '白方',
      zone: 'bl',
      layoutFill: 'rgba(220,240,220,0.15)',
      layoutStroke: 'rgba(180,220,180,0.55)',
      sideLight: ['rgba(150,196,170,1)', 'rgba(214,200,168,1)', 'rgba(230,225,210,1)', 'rgba(196,150,60,1)'],
      sideDark:  ['rgba(110,156,134,1)', 'rgba(176,160,124,1)', 'rgba(200,195,180,1)', 'rgba(140,100,30,1)'],
      darkPiece: false,
    },
  };

  const SKIN_INDEX = { jade: 1, ivory: 2, lacquer: 3 };

  function def(teamId) {
    return DEFS[teamId] || DEFS.white;
  }

  function getName(teamId) {
    return def(teamId).name;
  }

  function getLayoutZone(teamId, ww) {
    const pad = 14;
    const cx = ww.centerX;
    const cy = ww.centerY;
    const zones = {
      tl: {
        xMin: ww.boardLeft + pad,
        xMax: cx - pad,
        yMin: ww.boardTop + pad,
        yMax: cy - pad,
      },
      tr: {
        xMin: cx + pad,
        xMax: ww.boardRight - pad,
        yMin: ww.boardTop + pad,
        yMax: cy - pad,
      },
      bl: {
        xMin: ww.boardLeft + pad,
        xMax: cx - pad,
        yMin: cy + pad,
        yMax: ww.boardBottom - pad,
      },
      br: {
        xMin: cx + pad,
        xMax: ww.boardRight - pad,
        yMin: cy + pad,
        yMax: ww.boardBottom - pad,
      },
    };
    return zones[def(teamId).zone];
  }

  function isInLayoutZone(teamId, wx, wy, ww) {
    const z = getLayoutZone(teamId, ww);
    return wx > z.xMin && wx < z.xMax && wy > z.yMin && wy < z.yMax;
  }

  function getSideColors(teamId, skinId) {
    const d = def(teamId);
    const idx = SKIN_INDEX[skinId] || 0;
    return [d.sideLight[idx] || d.sideLight[0], d.sideDark[idx] || d.sideDark[0]];
  }

  function isDarkTeam(teamId) {
    return !!def(teamId).darkPiece;
  }

  function getLayoutStyle(teamId) {
    const d = def(teamId);
    return { fill: d.layoutFill, stroke: d.layoutStroke };
  }

  function nextLayoutTeam(confirmed) {
    for (const t of LAYOUT_ORDER) {
      if (!confirmed[t]) return t;
    }
    return null;
  }

  function nextTurnTeam(current, eliminated) {
    const elim = eliminated || new Set();
    let i = TURN_ORDER.indexOf(current);
    if (i < 0) i = 0;
    for (let step = 0; step < TURN_ORDER.length; step++) {
      i = (i + 1) % TURN_ORDER.length;
      const t = TURN_ORDER[i];
      if (!elim.has(t)) return t;
    }
    return null;
  }

  function initLayoutConfirmed() {
    return { black: false, white: false, red: false, blue: false };
  }

  function emptyKillByVictim() {
    return { black: 0, red: 0, blue: 0, white: 0 };
  }

  function initStats() {
    const stats = {};
    TURN_ORDER.forEach(t => {
      stats[t] = {
        shots: 0, hits: 0, maxCombo: 0, combo: 0,
        kills: 0,
        killByVictim: emptyKillByVictim(),
      };
    });
    return stats;
  }

  return {
    TURN_ORDER,
    LAYOUT_ORDER,
    AI_TEAMS,
    HUMAN_TEAM,
    PIECES_PER_TEAM,
    FFA_WALL_LEN_MULT,
    FFA_OBJECT_MULT,
    FFA_OBSTACLE_MULT,
    emptyKillByVictim,
    MASTER_AI_LEVEL,
    FFA_CAMERA_YAW,
    getName,
    getLayoutZone,
    isInLayoutZone,
    getSideColors,
    isDarkTeam,
    getLayoutStyle,
    nextLayoutTeam,
    nextTurnTeam,
    initLayoutConfirmed,
    initStats,
  };
})();
