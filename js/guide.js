// 玩法引导 — 图示 + 简述，点击继续，右上角跳过

const Guide = (() => {
  let step = 0;
  let bound = false;

  function steps() {
    return DATA.guideSteps || [];
  }

  function els() {
    return {
      root: document.getElementById('game-guide'),
      skip: document.getElementById('guide-skip'),
      indicator: document.getElementById('guide-step-indicator'),
      title: document.getElementById('guide-title'),
      art: document.getElementById('guide-art'),
      body: document.getElementById('guide-body'),
      next: document.getElementById('guide-next'),
    };
  }

  function renderStep() {
    const list = steps();
    const s = list[step];
    const { indicator, title, art, body, next } = els();
    if (!s || !title || !body) return;
    if (indicator) indicator.textContent = `${step + 1} / ${list.length}`;
    title.textContent = s.title;
    if (art && typeof GuideArt !== 'undefined') {
      art.innerHTML = GuideArt.render(s.id);
    }
    body.innerHTML = s.captions.map(c => `<p>${c}</p>`).join('');
    if (next) {
      next.textContent = step + 1 >= list.length ? '完成' : '下一步';
    }
  }

  function hide() {
    const { root } = els();
    if (root) root.classList.add('hidden');
  }

  function next() {
    if (step + 1 >= steps().length) {
      hide();
      return;
    }
    step += 1;
    renderStep();
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    const { root, skip, next: nextBtn } = els();
    if (skip) {
      skip.addEventListener('click', (e) => {
        e.stopPropagation();
        Audio.uiClick();
        hide();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        Audio.uiClick();
        next();
      });
    }
    if (root) {
      root.addEventListener('click', () => {
        Audio.uiClick();
        next();
      });
    }
  }

  function show() {
    const list = steps();
    if (!list.length) return;
    step = 0;
    bindEvents();
    renderStep();
    const { root } = els();
    if (root) root.classList.remove('hidden');
  }

  return { show };
})();
