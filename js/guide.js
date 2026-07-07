// 游戏引导 — 点击继续，右上角可跳过

const Guide = (() => {
  const STORAGE_KEY = 'tanqi_guide_seen';
  let step = 0;
  let onComplete = null;
  let bound = false;

  function isSeen() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function markSeen() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch (_) { /* ignore */ }
  }

  function shouldAutoShow() {
    return !isSeen();
  }

  function steps() {
    return DATA.guideSteps || [];
  }

  function els() {
    return {
      root: document.getElementById('game-guide'),
      skip: document.getElementById('guide-skip'),
      indicator: document.getElementById('guide-step-indicator'),
      title: document.getElementById('guide-title'),
      body: document.getElementById('guide-body'),
    };
  }

  function renderStep() {
    const list = steps();
    const s = list[step];
    const { indicator, title, body } = els();
    if (!s || !title || !body) return;
    if (indicator) indicator.textContent = `${step + 1} / ${list.length}`;
    title.textContent = s.title;
    body.innerHTML = s.paragraphs.map(p => `<p>${p}</p>`).join('');
  }

  function finish() {
    const { root } = els();
    if (root) root.classList.add('hidden');
    markSeen();
    const cb = onComplete;
    onComplete = null;
    if (cb) cb();
  }

  function next() {
    if (step + 1 >= steps().length) {
      finish();
      return;
    }
    step += 1;
    renderStep();
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    const { root, skip } = els();
    const card = root ? root.querySelector('.guide-card') : null;
    if (skip) {
      skip.addEventListener('click', (e) => {
        e.stopPropagation();
        Audio.uiClick();
        finish();
      });
    }
    if (card) {
      card.addEventListener('click', (e) => e.stopPropagation());
    }
    if (root) {
      root.addEventListener('click', () => {
        Audio.uiClick();
        next();
      });
    }
  }

  function show(completeCb) {
    const list = steps();
    if (!list.length) {
      if (completeCb) completeCb();
      return;
    }
    onComplete = completeCb || null;
    step = 0;
    bindEvents();
    renderStep();
    const { root } = els();
    if (root) root.classList.remove('hidden');
  }

  return { show, shouldAutoShow, isSeen };
})();
