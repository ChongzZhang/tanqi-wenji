// 玩法引导图示 — 内联 SVG

const GuideArt = (() => {
  const board = (inner) => `
    <rect x="24" y="20" width="272" height="272" rx="8" fill="#c4a574" stroke="#6b4420" stroke-width="3"/>
    <rect x="32" y="28" width="256" height="256" rx="4" fill="#dbc89a" stroke="#8b6914" stroke-width="1.5"/>
    ${inner}
  `;

  const piece = (cx, cy, fill, stroke, label) => `
    <circle cx="${cx}" cy="${cy}" r="11" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
    ${label ? `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="9" fill="#f4e6be" font-family="serif">${label}</text>` : ''}
  `;

  const illustrations = {
    layout: () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${board(`
          <rect x="32" y="28" width="256" height="120" fill="rgba(30,20,10,0.08)" stroke="none"/>
          <rect x="32" y="188" width="256" height="96" fill="rgba(240,235,220,0.35)" stroke="none"/>
          <line x1="32" y1="156" x2="288" y2="156" stroke="#8b6914" stroke-width="1" stroke-dasharray="6 4" opacity="0.6"/>
          <text x="160" y="52" text-anchor="middle" font-size="11" fill="#3a2010" font-family="serif">黑方区域 · 摆 6 子</text>
          <text x="160" y="248" text-anchor="middle" font-size="11" fill="#3a2010" font-family="serif">白方区域 · 摆 6 子</text>
          ${[[80,72],[130,90],[180,68],[230,85],[100,115],[200,110]].map(([x,y]) => piece(x,y,'#1a1208','#4a3010')).join('')}
          ${[[90,210],[150,225],[210,205],[240,230],[120,240],[180,218]].map(([x,y]) => piece(x,y,'#e8e0d0','#6a5040')).join('')}
          <g transform="translate(248,130)">
            <circle cx="0" cy="0" r="16" fill="rgba(255,255,255,0.85)" stroke="#6b4420" stroke-width="1.5"/>
            <text x="0" y="4" text-anchor="middle" font-size="11" fill="#6b4420" font-family="serif">点</text>
          </g>
          <text x="160" y="302" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">六子就位 → 确认布局</text>
        `)}
      </svg>`,

    fling: () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <marker id="arrowRed" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="#aa3030"/>
          </marker>
        </defs>
        ${board(`
          <ellipse cx="160" cy="156" rx="70" ry="50" fill="rgba(180,140,80,0.15)" stroke="none"/>
          ${piece(100, 200, '#1a1208', '#4a3010')}
          ${piece(220, 120, '#e8e0d0', '#6a5040')}
          <line x1="100" y1="200" x2="175" y2="145" stroke="#aa3030" stroke-width="2.5" marker-end="url(#arrowRed)"/>
          <path d="M 175 145 Q 210 110 248 78" fill="none" stroke="#e8e0d0" stroke-width="2" stroke-dasharray="5 3" opacity="0.9"/>
          <circle cx="248" cy="78" r="11" fill="#e8e0d0" stroke="#6a5040" stroke-width="2" opacity="0.5"/>
          <text x="268" y="62" font-size="10" fill="#aa3030" font-family="serif">出界!</text>
          <rect x="268" y="24" width="18" height="272" fill="none" stroke="#aa3030" stroke-width="2" stroke-dasharray="4 3" opacity="0.5"/>
        `)}
        <text x="160" y="308" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">拖拽瞄准 · 松手弹射 · 击落敌子</text>
      </svg>`,

    specials: () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${board(`
          ${piece(70, 230, '#1a1208', '#4a3010')}
          ${piece(110, 230, '#1a1208', '#4a3010', '曲')}
          ${piece(150, 230, '#1a1208', '#4a3010', '疾')}
          <path d="M 110 218 Q 90 170 75 120" fill="none" stroke="#2a6090" stroke-width="2.5" marker-end="url(#arrowBlue)"/>
          <text x="62" y="108" font-size="9" fill="#2a6090" font-family="serif">曲线棋·左偏</text>
          <line x1="150" y1="218" x2="230" y2="100" stroke="#c87820" stroke-width="2.5" marker-end="url(#arrowGold)"/>
          <text x="200" y="88" font-size="9" fill="#c87820" font-family="serif">疾行棋·1.5×速</text>
          <rect x="40" y="258" width="240" height="28" rx="4" fill="rgba(255,255,255,0.55)" stroke="#8b6914"/>
          <text x="160" y="276" text-anchor="middle" font-size="10" fill="#3a2010" font-family="serif">末两枚为奇兵（布局后自动生效）</text>
        `)}
        <defs>
          <marker id="arrowBlue" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#2a6090"/></marker>
          <marker id="arrowGold" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#c87820"/></marker>
        </defs>
      </svg>`,

    terrain: () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        ${board(`
          <ellipse cx="160" cy="156" rx="95" ry="75" fill="rgba(200,170,110,0.25)" stroke="rgba(139,105,20,0.35)" stroke-width="1"/>
          <ellipse cx="56" cy="56" rx="28" ry="22" fill="rgba(200,170,110,0.2)"/>
          <ellipse cx="264" cy="56" rx="28" ry="22" fill="rgba(200,170,110,0.2)"/>
          <ellipse cx="56" cy="256" rx="28" ry="22" fill="rgba(200,170,110,0.2)"/>
          <ellipse cx="264" cy="256" rx="28" ry="22" fill="rgba(200,170,110,0.2)"/>
          <text x="160" y="158" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">丰腹</text>
          ${piece(160, 130, '#e8e0d0', '#6a5040')}
          <path d="M 160 142 L 248 48" stroke="#aa3030" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arrowRed2)"/>
          <circle cx="248" cy="48" r="11" fill="#e8e0d0" stroke="#6a5040" stroke-width="2"/>
          <text x="160" y="200" text-anchor="middle" font-size="9" fill="#6b4420" font-family="serif">中央隆起 · 四角微隆 → 易向边沿滑</text>
        `)}
        <defs>
          <marker id="arrowRed2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#aa3030"/></marker>
        </defs>
      </svg>`,

    objects: () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <marker id="arrowGreen" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#5a9a5a"/></marker>
        </defs>
        ${board(`
          <circle cx="110" cy="130" r="20" fill="#888" stroke="#555" stroke-width="2" opacity="0.85"/>
          <text x="110" y="134" text-anchor="middle" font-size="8" fill="#fff" font-family="serif">障碍</text>
          <rect x="32" y="118" width="48" height="8" rx="2" fill="#5a9a5a" stroke="#2a6a2a" stroke-width="1"/>
          <text x="56" y="108" text-anchor="middle" font-size="8" fill="#2a6a2a" font-family="serif">反弹墙</text>
          <path d="M 80 122 L 110 100" stroke="#5a9a5a" stroke-width="1.5" marker-end="url(#arrowGreen)"/>
          <rect x="210" y="175" width="26" height="26" rx="3" fill="#7a6a58" stroke="#4a3a28" stroke-width="2" transform="rotate(12 223 188)"/>
          <text x="223" y="215" text-anchor="middle" font-size="8" fill="#4a3a28" font-family="serif">阻块</text>
          <circle cx="200" cy="120" r="18" fill="#1a1010" stroke="#333" stroke-width="2"/>
          <circle cx="200" cy="120" r="12" fill="#0a0808"/>
          <text x="200" y="148" text-anchor="middle" font-size="8" fill="#333" font-family="serif">陷洞</text>
          ${piece(160, 210, '#1a1208', '#4a3010')}
        `)}
        <text x="56" y="302" font-size="8" fill="#2a6a2a" font-family="serif">墙=高弹</text>
        <text x="160" y="302" text-anchor="middle" font-size="8" fill="#4a3a28" font-family="serif">块=卸力</text>
        <text x="264" y="302" text-anchor="middle" font-size="8" fill="#333" font-family="serif">洞=出局</text>
      </svg>`,

    'ffa-overview': () => {
      const quad = (x, y, w, h, fill, label, lx, ly) => `
        <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="rgba(80,50,10,0.25)" stroke-width="1"/>
        <text x="${lx}" y="${ly}" text-anchor="middle" font-size="9" fill="#3a2010" font-family="serif">${label}</text>`;
      return `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g transform="translate(160,158) rotate(-45) translate(-160,-158)">
          ${board(`
            ${quad(32, 28, 128, 128, 'rgba(30,50,30,0.14)', '黑', 96, 52)}
            ${quad(160, 28, 128, 128, 'rgba(120,40,30,0.14)', '红', 224, 52)}
            ${quad(32, 156, 128, 128, 'rgba(220,240,220,0.22)', '白·你', 96, 220)}
            ${quad(160, 156, 128, 128, 'rgba(30,50,100,0.14)', '蓝', 224, 220)}
            <line x1="160" y1="28" x2="160" y2="284" stroke="#8b6914" stroke-width="1" opacity="0.45"/>
            <line x1="32" y1="156" x2="288" y2="156" stroke="#8b6914" stroke-width="1" opacity="0.45"/>
            ${[[72,72],[110,95],[85,115]].map(([x,y]) => piece(x,y,'#1a1208','#4a3010')).join('')}
            ${[[230,70],[250,100],[210,110]].map(([x,y]) => piece(x,y,'#a03028','#601810')).join('')}
            ${[[70,210],[100,235],[130,215]].map(([x,y]) => piece(x,y,'#e8e0d0','#6a5040')).join('')}
            ${[[220,210],[240,240],[200,230]].map(([x,y]) => piece(x,y,'#4060a8','#203060')).join('')}
          `)}
        </g>
        <text x="160" y="302" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">四象限 · 各 6 子 · 3 AI 自动布局</text>
      </svg>`;
    },

    'ffa-general': () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g transform="translate(160,150) rotate(-45) translate(-160,-150)">
          ${board(`
            ${piece(88, 210, '#e8e0d0', '#6a5040')}
            ${piece(118, 228, '#e8e0d0', '#6a5040')}
            ${piece(148, 218, '#e8e0d0', '#6a5040')}
            <g>
              <circle cx="78" cy="232" r="13" fill="#e8e0d0" stroke="#c87820" stroke-width="2.5"/>
              <path d="M 68 224 L 78 214 L 88 224 L 85 224 L 85 228 L 71 228 L 71 224 Z" fill="#c87820"/>
              <text x="78" y="236" text-anchor="middle" font-size="7" fill="#6a5040" font-family="serif">主</text>
            </g>
            ${piece(230, 78, '#a03028', '#601810')}
            <path d="M 220 70 L 230 60 L 240 70 L 237 70 L 237 74 L 223 74 L 223 70 Z" fill="#ffd060" opacity="0.95"/>
            <text x="160" y="156" text-anchor="middle" font-size="9" fill="#6b4420" font-family="serif">首枚 = 主将</text>
          `)}
        </g>
        <text x="160" y="302" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">皇冠标记 · 主将出局 = 整队淘汰</text>
      </svg>`,

    'ffa-eliminate': () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <marker id="arrowMerge" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="#5a8040"/>
          </marker>
        </defs>
        <g transform="translate(160,148) rotate(-45) translate(-160,-148)">
          ${board(`
            ${piece(100, 200, '#e8e0d0', '#6a5040')}
            ${piece(140, 215, '#e8e0d0', '#6a5040')}
            ${piece(180, 205, '#4060a8', '#203060')}
            ${piece(210, 225, '#4060a8', '#203060')}
            <circle cx="248" cy="72" r="11" fill="#a03028" stroke="#601810" stroke-width="2" opacity="0.35"/>
            <text x="248" y="52" text-anchor="middle" font-size="9" fill="#aa3030" font-family="serif">红主将出局</text>
            <path d="M 230 90 Q 190 130 160 170" fill="none" stroke="#5a8040" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#arrowMerge)"/>
          `)}
        </g>
        <rect x="40" y="258" width="240" height="36" rx="4" fill="rgba(255,255,255,0.55)" stroke="#8b6914"/>
        <text x="160" y="280" text-anchor="middle" font-size="10" fill="#3a2010" font-family="serif">淘汰方棋子 → 收编入你的阵营</text>
      </svg>`,

    'ffa-turn': () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <marker id="arrowTurn" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill="#6b4420"/>
          </marker>
        </defs>
        <g transform="translate(160,152) rotate(-45) translate(-160,-152)">
          ${board(`
            ${piece(90, 215, '#e8e0d0', '#6a5040')}
            ${piece(220, 85, '#1a1208', '#4a3010')}
            ${piece(230, 220, '#4060a8', '#203060')}
            ${piece(85, 85, '#a03028', '#601810')}
            <path d="M 160 248 A 88 88 0 1 1 159.9 248" fill="none" stroke="#6b4420" stroke-width="2" marker-end="url(#arrowTurn)" opacity="0.85"/>
          `)}
        </g>
        <g font-family="serif" font-size="10" fill="#3a2010">
          <text x="52" y="268">白</text>
          <text x="92" y="268">→ 黑</text>
          <text x="142" y="268">→ 红</text>
          <text x="192" y="268">→ 蓝</text>
          <text x="242" y="268">→ …</text>
        </g>
        <text x="160" y="302" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">你（白）先手 · 弹击规则同单挑</text>
      </svg>`,

    'ffa-objects': () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g transform="translate(160,150) rotate(-45) translate(-160,-150)">
          ${board(`
            <circle cx="100" cy="120" r="16" fill="#888" stroke="#555" stroke-width="2"/>
            <circle cx="190" cy="170" r="16" fill="#888" stroke="#555" stroke-width="2"/>
            <text x="160" y="118" text-anchor="middle" font-size="8" fill="#555" font-family="serif">障碍</text>
            <rect x="32" y="130" width="56" height="8" rx="2" fill="#5a9a5a" stroke="#2a6a2a"/>
            <rect x="210" y="95" width="40" height="8" rx="2" fill="#5a9a5a" stroke="#2a6a2a"/>
            <rect x="175" y="200" width="24" height="24" rx="3" fill="#7a6a58" stroke="#4a3a28" transform="rotate(8 187 212)"/>
            <circle cx="200" cy="130" r="16" fill="#1a1010" stroke="#333" stroke-width="2"/>
            <circle cx="200" cy="130" r="10" fill="#0a0808"/>
            ${piece(160, 210, '#e8e0d0', '#6a5040')}
          `)}
        </g>
        <text x="160" y="292" text-anchor="middle" font-size="9" fill="#2a6a2a" font-family="serif">墙+30% · 阻块+40%</text>
        <text x="160" y="306" text-anchor="middle" font-size="9" fill="#333" font-family="serif">陷洞不变 · 一入即出局</text>
      </svg>`,

    'ffa-view': () => `
      <svg class="guide-svg" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="20" y="16" width="280" height="288" rx="10" fill="rgba(255,252,245,0.35)" stroke="rgba(140,90,20,0.25)"/>
        <g transform="translate(160,156) rotate(-45) translate(-160,-156)">
          ${board(`
            <rect x="32" y="156" width="128" height="128" fill="rgba(220,240,220,0.25)" stroke="rgba(180,220,180,0.5)" stroke-width="1.5"/>
            ${[[70,210],[100,230],[130,215]].map(([x,y]) => piece(x,y,'#e8e0d0','#6a5040')).join('')}
            <text x="96" y="248" text-anchor="middle" font-size="9" fill="#3a6040" font-family="serif">你</text>
          `)}
        </g>
        <path d="M 160 28 L 175 48 L 145 48 Z" fill="#c87820"/>
        <text x="160" y="22" text-anchor="middle" font-size="9" fill="#6b4420" font-family="serif">屏幕下方</text>
        <text x="48" y="156" font-size="22" fill="#6b4420" opacity="0.35" font-family="serif">◆</text>
        <text x="160" y="302" text-anchor="middle" font-size="10" fill="#6b4420" font-family="serif">菱形视角 -45° · 白方恒在下方</text>
      </svg>`,
  };

  function render(stepId) {
    const fn = illustrations[stepId];
    return fn ? fn() : '';
  }

  return { render };
})();
