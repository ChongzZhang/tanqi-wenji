// 模式页内嵌玩法指引 — 随选中模式切换内容与图示

const ModeGuide = (() => {
  const MODE_LABELS = { duel: '单挑大师', ffa: '四方乱战' };
  let mode = 'duel';
  let step = 0;
  let bound = false;

  function steps() {
    const guides = DATA.modeGuides || {};
    return guides[mode] || guides.duel || DATA.guideSteps || [];
  }

  function els() {
    return {
      label: document.getElementById('mode-guide-label'),
      indicator: document.getElementById('mode-guide-indicator'),
      title: document.getElementById('mode-guide-title'),
      art: document.getElementById('mode-guide-art'),
      body: document.getElementById('mode-guide-body'),
      prev: document.getElementById('mode-guide-prev'),
      next: document.getElementById('mode-guide-next'),
    };
  }

  function renderStep() {
    const list = steps();
    if (!list.length) return;
    if (step >= list.length) step = list.length - 1;
    if (step < 0) step = 0;

    const s = list[step];
    const { label, indicator, title, art, body, prev, next } = els();
    if (!s || !title || !body) return;

    if (label) label.textContent = MODE_LABELS[mode] || mode;
    if (indicator) indicator.textContent = `${step + 1} / ${list.length}`;
    title.textContent = s.title;
    if (art && typeof GuideArt !== 'undefined') {
      art.innerHTML = GuideArt.render(s.id);
    }
    body.innerHTML = s.captions.map(c => `<p>${c}</p>`).join('');
    if (prev) prev.disabled = step <= 0;
    if (next) {
      next.textContent = step + 1 >= list.length ? '已阅毕' : '下一步';
      next.classList.toggle('mode-guide-done', step + 1 >= list.length);
    }
  }

  function setMode(m) {
    if (m !== 'duel' && m !== 'ffa') m = 'duel';
    if (mode !== m) step = 0;
    mode = m;
    renderStep();
  }

  function prev() {
    if (step <= 0) return;
    step -= 1;
    renderStep();
  }

  function next() {
    const list = steps();
    if (step + 1 >= list.length) return;
    step += 1;
    renderStep();
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    const { prev: prevBtn, next: nextBtn } = els();
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        Audio.uiClick();
        prev();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        Audio.uiClick();
        next();
      });
    }
  }

  function init() {
    bindEvents();
    setMode('duel');
  }

  return { init, setMode, renderStep };
})();
