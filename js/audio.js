// 《幽寂弹棋》音效系统 — Web Audio API 合成

const Audio = (() => {
  let ctx = null;
  let masterGain = null;
  let sfxGain = null;
  let ambGain = null;
  let ambientNodes = [];
  let birdTimer = null;

  function init() {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(ctx.destination);

      sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.8;
      sfxGain.connect(masterGain);

      ambGain = ctx.createGain();
      ambGain.gain.value = 0.25;
      ambGain.connect(masterGain);
    } catch (e) {
      console.warn('Web Audio API 不可用');
    }
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // 棋子碰撞音效（玉石/木质材质）
  function pieceHit(velocity = 1, material = 'jade') {
    if (!ctx) return;
    resume();
    const t = ctx.currentTime;

    const baseFreq = material === 'jade' ? 900 : material === 'ivory' ? 700 : 500;
    const decay = material === 'jade' ? 0.15 : 0.25;

    // 点击噪音
    const bufferSize = ctx.sampleRate * 0.05;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = baseFreq * 0.5;
    noiseFilter.Q.value = 2;

    const noiseGain = ctx.createGain();
    const vol = Math.min(velocity, 1) * 0.4;
    noiseGain.gain.setValueAtTime(vol, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(sfxGain);
    noiseSource.start(t);

    // 音调泛音
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.6, t + decay);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(vol * 0.5, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    osc.connect(oscGain);
    oscGain.connect(sfxGain);
    osc.start(t);
    osc.stop(t + decay + 0.01);
  }

  // 棋子弹出音效
  function pieceFling(force = 0.5) {
    if (!ctx) return;
    resume();
    const t = ctx.currentTime;

    const bufferSize = ctx.sampleRate * 0.08;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2) * 0.3;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(force * 0.6, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(sfxGain);
    source.start(t);
  }

  // 棋子落盘音效
  function pieceFall() {
    if (!ctx) return;
    resume();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.3);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);

    osc.connect(gain);
    gain.connect(sfxGain);
    osc.start(t);
    osc.stop(t + 0.4);

    // 小木声
    const bufferSize = ctx.sampleRate * 0.06;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 4) * 0.5;
    }
    const ns = ctx.createBufferSource();
    ns.buffer = buffer;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    ns.connect(ng);
    ng.connect(sfxGain);
    ns.start(t);
  }

  // UI点击音效
  function uiClick() {
    if (!ctx) return;
    resume();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.05);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

    osc.connect(gain);
    gain.connect(sfxGain);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  // 卷轴展开音效
  function scrollOpen() {
    if (!ctx) return;
    resume();
    const t = ctx.currentTime;

    const bufferSize = ctx.sampleRate * 0.2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const progress = i / bufferSize;
      data[i] = (Math.random() * 2 - 1) * progress * (1 - progress) * 0.4;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3000;
    filter.Q.value = 0.5;

    const gain = ctx.createGain();
    gain.gain.value = 0.5;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(sfxGain);
    source.start(t);
  }

  // 胜利提示音
  function victory() {
    if (!ctx) return;
    resume();
    const freqs = [523, 659, 784, 1047];
    freqs.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.15;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(gain);
      gain.connect(sfxGain);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  // 环境音：风声
  function createWindNode() {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 600;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 100;
    lfo.connect(lfoGain);
    lfoGain.connect(lowpass.frequency);

    const gain = ctx.createGain();
    gain.gain.value = 0.3;

    source.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(ambGain);
    source.start();
    lfo.start();
    return [source, lfo, gain];
  }

  // 鸟鸣（随机）
  function chirpBird() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const baseNote = [700, 900, 1100, 1300][Math.floor(Math.random() * 4)];
    const numChirps = 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < numChirps; i++) {
      const delay = t + i * 0.12;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseNote, delay);
      osc.frequency.setValueAtTime(baseNote * 1.2, delay + 0.04);
      osc.frequency.setValueAtTime(baseNote, delay + 0.08);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, delay);
      gain.gain.linearRampToValueAtTime(0.15, delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, delay + 0.1);

      osc.connect(gain);
      gain.connect(ambGain);
      osc.start(delay);
      osc.stop(delay + 0.12);
    }
  }

  // 开启环境音
  function startAmbient() {
    if (!ctx) return;
    resume();
    ambientNodes = createWindNode();

    function scheduleBird() {
      if (!ctx) return;
      chirpBird();
      const nextIn = 4000 + Math.random() * 8000;
      birdTimer = setTimeout(scheduleBird, nextIn);
    }
    birdTimer = setTimeout(scheduleBird, 2000);
  }

  // 停止环境音
  function stopAmbient() {
    if (birdTimer) clearTimeout(birdTimer);
    ambientNodes.forEach(n => {
      try { n.stop(); } catch (e) {}
    });
    ambientNodes = [];
  }

  // 音量控制
  function setSfxVolume(v) {
    if (sfxGain) sfxGain.gain.value = Math.max(0, Math.min(1, v));
  }

  function setAmbVolume(v) {
    if (ambGain) ambGain.gain.value = Math.max(0, Math.min(0.4, v * 0.4));
  }

  function setMasterVolume(v) {
    if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
  }

  return {
    init,
    resume,
    pieceHit,
    pieceFling,
    pieceFall,
    uiClick,
    scrollOpen,
    victory,
    startAmbient,
    stopAmbient,
    setSfxVolume,
    setAmbVolume,
    setMasterVolume,
  };
})();
