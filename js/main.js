// 《弹棋问机·联机对战》入口

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas');
  Game.init(canvas);
  Game.initCanvasClickHandler(canvas);

  function loop(ts) {
    try {
      Game.update(ts);
      Game.render();
    } catch (err) {
      console.error('游戏主循环异常：', err);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  const els = {
    status: document.getElementById('online-status'),
    entry: document.getElementById('online-entry-panel'),
    hostPanel: document.getElementById('online-host-panel'),
    guestPanel: document.getElementById('online-guest-panel'),
    roomCode: document.getElementById('online-room-code'),
    guestRoomCode: document.getElementById('online-guest-room-code'),
    hostHint: document.getElementById('online-host-hint'),
    startBtn: document.getElementById('btn-online-start'),
    roomInput: document.getElementById('online-room-input'),
    hostBtn: document.getElementById('btn-online-host'),
    joinBtn: document.getElementById('btn-online-join'),
    resumeBtn: document.getElementById('btn-online-resume'),
    copyInviteBtn: document.getElementById('btn-copy-invite'),
    inviteHint: document.getElementById('online-invite-hint'),
    guestHint: document.getElementById('online-guest-hint'),
  };

  function setGuestHint(text) {
    if (els.guestHint) els.guestHint.textContent = text;
  }

  function lobbyHintText() {
    if (Online.isPublicAccess()) {
      return '好友只需用手机/电脑浏览器打开您分享的链接，无需安装任何程序。';
    }
    return '局域网好友可访问您的 IP:8080；公网好友请房主运行 serve-public.bat 后分享 Cloudflare 链接。';
  }

  function setJoinBusy(busy) {
    if (els.joinBtn) {
      els.joinBtn.disabled = busy;
      els.joinBtn.textContent = busy ? '正在加入…' : '加入房间';
    }
    if (els.hostBtn && busy) els.hostBtn.disabled = true;
  }

  function checkServerGameEngine() {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => {
        if (!d.gameEngine) {
          setOnlineStatus('服务器版本过旧！请房主关闭旧服务窗口，重新运行 serve-public.bat。');
        }
      })
      .catch(() => {});
  }

  function setOnlineStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function updateResumeButton() {
    if (!els.resumeBtn) return;
    const show = Online.isInMatch();
    els.resumeBtn.classList.toggle('hidden', !show);
    if (show) {
      els.resumeBtn.disabled = false;
      els.resumeBtn.textContent = '回到进行中的对局';
    }
  }

  async function resumeActiveMatchIfAny() {
    if (!Online.isInMatch()) return false;
    if (els.resumeBtn) els.resumeBtn.disabled = true;
    setOnlineStatus('正在回到进行中的对局…');
    const ok = await Online.tryResume();
    if (!ok) {
      Online.markInMatch(false);
      updateResumeButton();
      setOnlineStatus('无法恢复对局（房间可能已过期），请重新创建或加入房间。');
      return false;
    }
    if (Online.isInMatch()) {
      Game.onOnlineResumed();
      setOnlineStatus('已回到对局，等待同步…');
      return true;
    }
    updateResumeButton();
    setOnlineStatus('已恢复联机会话。');
    applyLobbyFromRole();
    return true;
  }

  function showLobbyMode(mode) {
    const isIdle = mode === 'idle';
    const isHost = mode === 'host';
    const isGuest = mode === 'guest';
    if (els.entry) els.entry.classList.toggle('hidden', !isIdle);
    if (els.hostPanel) els.hostPanel.classList.toggle('hidden', !isHost);
    if (els.guestPanel) els.guestPanel.classList.toggle('hidden', !isGuest);
  }

  function resetOnlineLobby(fullLeave = true) {
    window._matchUIEntered = false;
    if (fullLeave && Online.isConnected()) {
      Online.leave();
    } else if (fullLeave && !Online.isInMatch()) {
      Online.resetSession();
    }
    showLobbyMode('idle');
    if (els.roomInput) els.roomInput.value = '';
    if (els.hostBtn) els.hostBtn.disabled = false;
    if (els.joinBtn) {
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = '加入房间';
    }
    if (els.startBtn) {
      els.startBtn.disabled = true;
      els.startBtn.textContent = '等待对方加入…';
    }
    if (els.hostHint) els.hostHint.textContent = '将房间号发给好友，等待对方加入…';
    if (els.copyInviteBtn) els.copyInviteBtn.classList.add('hidden');
    const hint = lobbyHintText();
    setOnlineStatus(`创建房间（房主）或输入房间号加入。${hint}`);
    if (els.inviteHint) els.inviteHint.textContent = hint;
    updateResumeButton();
  }

  function applyLobbyFromRole() {
    const role = Online.getRole();
    const code = Online.getRoomCode();
    if (!role || !code) return false;
    if (role === 'host') {
      showLobbyMode('host');
      if (els.roomCode) els.roomCode.textContent = code;
      updateInviteUI(code);
      setHostReadyToStart(Online.hasPeer());
      setOnlineStatus(Online.hasPeer()
        ? '对方已加入！双方即将同时盲布局…'
        : `您是房主，房间号 ${code} — 发给好友加入。`);
    } else {
      showLobbyMode('guest');
      if (els.guestRoomCode) els.guestRoomCode.textContent = code;
      setGuestHint('已连接！正在同步棋盘，即将与房主同时盲布局…');
      setOnlineStatus(`已加入房间 ${code}，即将进入同时布子。`);
      if (els.hostBtn) els.hostBtn.disabled = true;
      if (els.joinBtn) els.joinBtn.disabled = true;
    }
    return true;
  }

  function updateInviteUI(code) {
    if (!code) return;
    if (els.copyInviteBtn) els.copyInviteBtn.classList.remove('hidden');
    const inviteUrl = Online.buildInviteUrl(code);
    if (els.inviteHint) {
      els.inviteHint.textContent = Online.isPublicAccess()
        ? `邀请链接（发给好友，打开即自动加入）：${inviteUrl}`
        : `当前为本地地址，公网好友无法加入。请运行 serve-public.bat 后用 Cloudflare 链接分享：${inviteUrl}`;
    }
  }

  async function copyInviteLink(code) {
    const url = Online.buildInviteUrl(code || Online.getRoomCode());
    try {
      await navigator.clipboard.writeText(url);
      setOnlineStatus('邀请链接已复制！发给好友，对方用浏览器打开即可加入，无需安装程序。');
    } catch {
      prompt('请复制以下邀请链接发给好友：', url);
    }
  }

  async function doJoinRoom(code) {
    const trimmed = String(code || '').trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setOnlineStatus('请输入 6 位数字房间号');
      return false;
    }
    setJoinBusy(true);
    try {
      if (typeof Game !== 'undefined' && Game.resetOnlineSyncSeq) {
        Game.resetOnlineSyncSeq();
      }
      setOnlineStatus('正在连接并加入房间…');
      const joined = await Online.joinRoom(trimmed);
      showLobbyMode('guest');
      if (els.guestRoomCode) els.guestRoomCode.textContent = joined;
      setGuestHint('已连接！正在同步棋盘，即将与房主同时盲布局…');
      setOnlineStatus(`已加入房间 ${joined}，即将进入同时布子。`);
      checkServerGameEngine();
      Game.onGuestJoinedOnline();
      setJoinBusy(false);
      if (els.hostBtn) els.hostBtn.disabled = true;
      return true;
    } catch (e) {
      let msg = e.message || '加入失败';
      showLobbyMode('idle');
      if (Online.isLocalDev()) {
        msg += ' — 请确认房主已运行 serve-public.bat，并使用房主分享的 https 邀请链接（不要用 localhost）。';
      }
      setOnlineStatus(msg);
      setJoinBusy(false);
      if (els.hostBtn) els.hostBtn.disabled = false;
      return false;
    }
  }

  function setHostReadyToStart(ready) {
    if (!els.startBtn) return;
    els.startBtn.disabled = true;
    els.startBtn.textContent = ready ? '双方同时布子中…' : '等待对方加入…';
    if (els.hostHint) {
      els.hostHint.textContent = ready
        ? '对方已加入，双方正在同时盲布局。'
        : '将邀请链接发给好友，等待对方加入…';
    }
  }

  let selectedPlayMode = 'duel';

  function updateModeDesc() {
    const modeEl = document.getElementById('mode-desc');
    const typeEl = document.getElementById('type-desc');
    if (!modeEl) return;
    if (selectedPlayMode === 'ffa') {
      if (typeEl) typeEl.textContent = '四方乱战 — 四角布局，主将带皇冠；击落空主将可收编该方全部棋子。';
      modeEl.textContent = '你在屏幕下方区域布局 6 枚，首枚为主将；黑/红/蓝三 AI 自动布阵。';
    } else {
      if (typeEl) typeEl.textContent = '趣味局 — 反弹墙、陷洞、阻块与奇兵棋子。';
      modeEl.textContent = '确认后将进入布局；不熟悉规则请先阅读主菜单「玩法引导」。';
    }
  }

  function startSinglePlayerGame() {
    Game.showScreen('game-screen');
    Game.startGame('1P', 2, Game.state.boardSkin, Game.state.pieceSkin, 'fun');
  }

  function startFourWayGame() {
    Game.showScreen('game-screen');
    Game.startFourWayGame(Game.state.boardSkin, Game.state.pieceSkin);
  }

  function bindModeCards() {
    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        Audio.uiClick();
        selectedPlayMode = card.dataset.mode || 'duel';
        document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        updateModeDesc();
      });
    });
  }
  bindModeCards();

  document.getElementById('btn-start').addEventListener('click', () => {
    Audio.resume();
    Audio.uiClick();
    Game.showScreen('mode-select');
    updateModeDesc();
  });

  document.getElementById('btn-guide').addEventListener('click', () => {
    Audio.uiClick();
    Guide.show();
  });

  document.getElementById('btn-culture').addEventListener('click', () => {
    Audio.uiClick();
    Game.showScreen('culture-screen');
    buildCultureContent();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    Audio.uiClick();
    Game.showScreen('settings-screen');
  });

  document.getElementById('btn-go').addEventListener('click', () => {
    Audio.uiClick();
    Audio.resume();
    if (selectedPlayMode === 'ffa') startFourWayGame();
    else startSinglePlayerGame();
  });

  document.getElementById('btn-mode-back').addEventListener('click', () => {
    Audio.uiClick();
    Game.showScreen('main-menu');
  });

  document.getElementById('btn-online-back').addEventListener('click', () => {
    Audio.uiClick();
    resetOnlineLobby();
    Game.showScreen('mode-select');
  });

  function isGameScreenVisible() {
    const el = document.getElementById('game-screen');
    return el && !el.classList.contains('hidden');
  }

  function enterMatchUI(phase) {
    if (window._lobbyWatchId) {
      clearInterval(window._lobbyWatchId);
      window._lobbyWatchId = null;
    }
    if (!isGameScreenVisible()) {
      Game.showScreen('game-screen');
    }
    window._matchUIEntered = true;
    if (phase === 'layout') {
      setOnlineStatus('请布置己方六枚棋子，完成后点击确认。');
    }
  }

  function shouldEnterMatchFromState(data) {
    const phase = data?.state?.phase;
    if (phase !== 'layout' && phase !== 'playing' && phase !== 'gameover') return false;
    if (phase === 'layout') {
      return !!(data.state?.board || data.full);
    }
    return true;
  }

  function startLobbyWatch() {
    if (window._lobbyWatchId) clearInterval(window._lobbyWatchId);
    let stallCount = 0;
    window._lobbyWatchId = setInterval(() => {
      const lobby = document.getElementById('online-lobby');
      if (!lobby || lobby.classList.contains('hidden')) {
        clearInterval(window._lobbyWatchId);
        window._lobbyWatchId = null;
        return;
      }
      if (!Online.isConnected() || !Online.hasPeer()) return;
      Online.requestGameStart();
      const phase = Online.getMatchPhase() || Game.state.phase;
      if ((phase === 'layout' || phase === 'playing') && isGameScreenVisible()) {
        clearInterval(window._lobbyWatchId);
        window._lobbyWatchId = null;
        return;
      }
      if (phase === 'layout' || phase === 'playing') {
        enterMatchUI(phase);
        return;
      }
      stallCount++;
      if (stallCount >= 3) {
        setOnlineStatus('仍未进入对局：请双方 Ctrl+F5 强制刷新后重新建房。');
      }
    }, 3000);
  }

  Online.on('peer_joined', (data) => {
    if (Online.getRole() === 'host') {
      if (Game.state.phase === 'playing' || Game.state.phase === 'layout') {
        setOnlineStatus(data?.resumed ? '对方已回到对局，计时继续。' : '对方已回到对局。');
        return;
      }
      setHostReadyToStart(true);
      setOnlineStatus('对方已加入！双方即将同时盲布局…');
      Online.requestGameStart();
      startLobbyWatch();
    }
  });

  Online.on('joined', () => {
    setGuestHint('正在同步棋盘，即将进入布子…');
    Online.requestGameStart();
    startLobbyWatch();
  });

  Online.on('match_ready', (data) => {
    const phase = data?.phase;
    if (Online.getRole() === 'guest') {
      setGuestHint('正在加载棋盘…');
    } else if (phase === 'layout' || phase === 'playing') {
      setOnlineStatus('对方已加入，正在进入布子…');
    }
    Online.requestGameStart();
  });

  Online.on('game_state', (data) => {
    if (!shouldEnterMatchFromState(data)) return;
    enterMatchUI(data.state.phase);
  });

  Online.on('peer_left', (data) => {
    if (data && data.temporary) {
      if (Online.getRole() === 'host') {
        setHostReadyToStart(false);
        if (Game.state.phase === 'playing' || Game.state.phase === 'layout') {
          setOnlineStatus('对方暂时离开，对局计时已暂停…');
        } else {
          setOnlineStatus('对方暂时离线，等待重连…');
        }
      } else {
        if (Game.state.phase === 'playing' || Game.state.phase === 'layout') {
          setOnlineStatus('房主暂时离开，对局计时已暂停…');
        } else {
          setOnlineStatus('房主暂时离线，等待重连…');
        }
      }
      return;
    }
    if (Online.getRole() === 'host') {
      setHostReadyToStart(false);
      setOnlineStatus('对方已离开，继续等待或分享房间号给其他人。');
    } else if (Online.getRole() === 'guest') {
      setOnlineStatus('房主已离开房间。');
      resetOnlineLobby(false);
    }
  });

  Online.on('disconnected', () => {
    setOnlineStatus('与服务器断开，正在尝试重连…');
    if (Online.getRole() === 'host') setHostReadyToStart(false);
  });

  Online.on('reconnecting', () => {
    setOnlineStatus('重连中…');
  });

  Online.on('resumed', () => {
    applyLobbyFromRole();
    if (Online.isInMatch()) {
      Game.onOnlineResumed();
      setOnlineStatus('已回到对局，等待同步…');
      return;
    }
    if (Online.hasPeer()) {
      Online.requestGameStart();
    }
    setOnlineStatus('已恢复联机会话。');
    updateResumeButton();
  });

  Online.on('no_room', (data) => {
    resetOnlineLobby(false);
    setOnlineStatus(data.message || '房间不存在或已回收，请重新创建或加入。');
  });

  Online.on('host_offline', () => {
    setOnlineStatus('房主暂时掉线，等待重连或自动移交房主（约 90 秒）…');
  });

  Online.on('host_online', () => {
    if (Game.state.phase === 'playing' || Game.state.phase === 'layout') {
      setOnlineStatus('对方已回到对局，计时继续。');
    } else {
      setOnlineStatus('房主已重新上线。');
    }
  });

  document.getElementById('btn-online-afk')?.addEventListener('click', () => {
    Audio.uiClick();
    Game.temporaryLeaveOnline();
  });

  document.getElementById('btn-online-quit-match')?.addEventListener('click', () => {
    Audio.uiClick();
    Game.quitOnlineMatchFull();
  });

  document.getElementById('btn-sp-quit')?.addEventListener('click', () => {
    Audio.uiClick();
    Game.quitSinglePlayerMatch();
  });

  Online.on('host_migrated', (data) => {
    if (Online.getRole() === 'host') {
      setOnlineStatus('您已成为新房主。');
      if (typeof Game !== 'undefined' && Game.state) {
        Game.state.onlineRole = 'host';
      }
    } else {
      setOnlineStatus('房主已更换，请等待新房主操作。');
    }
    applyLobbyFromRole();
  });

  Online.on('error', (data) => {
    if (data.message) setOnlineStatus(data.message);
  });

  async function switchToHostCreate() {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url.pathname + (url.search || ''));
    try {
      await Online.abandonMatchForNewRoom();
    } catch { /* ignore */ }
    if (typeof Game !== 'undefined' && Game.resetOnlineMatchState) {
      Game.resetOnlineMatchState();
    }
    resetOnlineLobby(false);
    showLobbyMode('idle');
    if (els.hostBtn) els.hostBtn.disabled = false;
    if (els.joinBtn) {
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = '加入房间';
    }
    setOnlineStatus('请创建房间，然后将邀请链接发给好友。');
  }

  els.resumeBtn?.addEventListener('click', async () => {
    Audio.uiClick();
    await resumeActiveMatchIfAny();
  });

  els.hostBtn.addEventListener('click', async () => {
    Audio.uiClick();
    if (els.hostBtn.disabled) return;
    els.hostBtn.disabled = true;
    if (els.joinBtn) els.joinBtn.disabled = true;
    try {
      setOnlineStatus('正在创建房间…');
      if (typeof Game !== 'undefined' && Game.resetOnlineSyncSeq) {
        Game.resetOnlineSyncSeq();
      }
      const code = await Online.createRoom();
      showLobbyMode('host');
      if (els.roomCode) els.roomCode.textContent = code;
      updateInviteUI(code);
      setHostReadyToStart(false);
      setOnlineStatus(`您是房主，房间号 ${code} — 点击「复制邀请链接」发给好友。`);
      checkServerGameEngine();
      if (els.joinBtn) els.joinBtn.disabled = false;
    } catch (e) {
      showLobbyMode('idle');
      els.hostBtn.disabled = false;
      if (els.joinBtn) els.joinBtn.disabled = false;
      setOnlineStatus(e.message || '创建失败');
    }
  });

  els.joinBtn.addEventListener('click', async () => {
    Audio.uiClick();
    const code = els.roomInput ? els.roomInput.value.trim() : '';
    await doJoinRoom(code);
  });

  if (els.copyInviteBtn) {
    els.copyInviteBtn.addEventListener('click', async () => {
      Audio.uiClick();
      await copyInviteLink();
    });
  }

  const becomeHostBtn = document.getElementById('btn-become-host');
  if (becomeHostBtn) {
    becomeHostBtn.addEventListener('click', async () => {
      Audio.uiClick();
      await switchToHostCreate();
    });
  }

  if (els.startBtn) {
    els.startBtn.addEventListener('click', () => {
      if (!Online.hasPeer()) {
        setOnlineStatus('对方尚未加入，请分享邀请链接。');
        return;
      }
      Audio.uiClick();
      Online.requestGameStart();
      startLobbyWatch();
    });
  }

  const volSfx = document.getElementById('vol-sfx');
  const volAmb = document.getElementById('vol-amb');
  if (volSfx) volSfx.addEventListener('input', e => Audio.setSfxVolume(+e.target.value));
  if (volAmb) volAmb.addEventListener('input', e => Audio.setAmbVolume(+e.target.value));

  document.querySelectorAll('.skin-board-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.skin-board-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Game.state.boardSkin = btn.dataset.skin;
      Audio.uiClick();
    });
  });

  document.querySelectorAll('.skin-piece-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.skin-piece-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Game.state.pieceSkin = btn.dataset.skin;
      Audio.uiClick();
    });
  });

  document.getElementById('btn-settings-back').addEventListener('click', () => {
    Audio.uiClick();
    Game.showScreen('main-menu');
  });

  document.getElementById('btn-culture-back').addEventListener('click', () => {
    Audio.uiClick();
    Game.showScreen('main-menu');
  });

  if (els.roomInput) {
    els.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && els.joinBtn && !els.joinBtn.disabled) {
        e.preventDefault();
        els.joinBtn.click();
      }
    });
  }

  function buildCultureContent() {
    const container = document.getElementById('culture-content');
    if (!container || container.dataset.built) return;
    container.dataset.built = '1';

    let html = '<section><h2>弹棋历史沿革</h2><div class="timeline">';
    DATA.history.forEach(h => {
      html += `<div class="timeline-item"><span class="era">${h.era}</span><p>${h.desc}</p></div>`;
    });
    html += '</div></section>';

    html += '<section><h2>古籍引语</h2>';
    DATA.quotes.forEach(q => {
      html += `<blockquote><p>「${q.text}」</p><cite>— ${q.source}</cite></blockquote>`;
    });
    html += '</section>';

    html += '<section><h2>弹棋诗文</h2>';
    DATA.poems.forEach(p => {
      html += `<div class="poem"><h3>《${p.title}》</h3><p class="author">${p.author}</p>`;
      p.lines.forEach(l => { html += `<p class="line">${l}</p>`; });
      html += '</div>';
    });
    html += '</section>';

    html += '<section><h2>名人故事</h2>';
    DATA.stories.forEach(s => {
      html += `<div class="story"><h3>${s.title}</h3><p class="person">人物：${s.person}</p><p>${s.content}</p></div>`;
    });
    html += '</section>';

    const visibleAi = DATA.aiLevels.filter(a => a.visible !== false);
    if (visibleAi.length) {
      html += '<section><h2>门客简介</h2>';
      visibleAi.forEach(a => {
        html += `<div class="story"><h3>${a.name}（${a.title}）</h3><p>${a.desc}</p></div>`;
      });
      html += '</section>';
    }

    container.innerHTML = html;
  }

  updateModeDesc();

  (async () => {
    const params = new URLSearchParams(location.search);
    const inviteCode = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);

    if (inviteCode.length === 6) {
      Game.showScreen('online-lobby');
      if (els.roomInput) els.roomInput.value = inviteCode;
      setOnlineStatus('检测到邀请链接，正在自动加入房间…（若要建房请点下方「我要当房主」）');
      const ok = await doJoinRoom(inviteCode);
      if (!ok) {
        setOnlineStatus(
          (document.getElementById('online-status')?.textContent || '加入失败') +
          ' — 请确认房主已开启公网房间，或稍后重试。'
        );
      }
      return;
    }

    if (Online.hasStoredSession()) {
      setOnlineStatus('检测到上次联机会话，正在恢复…');
      const ok = await Online.tryResume();
      if (ok) {
        if (Online.isInMatch()) {
          Game.onOnlineResumed();
          setOnlineStatus('已回到对局，等待同步…');
          return;
        }
        Game.showScreen('online-lobby');
        applyLobbyFromRole();
        if (Online.getRole() === 'host') {
          updateInviteUI(Online.getRoomCode());
          if (Online.hasPeer()) Game.onPeerJoinedOnline();
        } else if (Online.getRole() === 'guest') {
          Game.onGuestJoinedOnline();
        }
        return;
      }
    }
    Game.showScreen('main-menu');
  })();
});
