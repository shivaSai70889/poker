const $ = (id) => document.getElementById(id);
const socket = io();

let ME = null;
let CODE = null;
let S = null;
let myName = '';
let lastTurnId = null;

/* ══════════ AUDIO ══════════ */
let audioCtx = null;
function initAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}
document.addEventListener('pointerdown', () => initAudio(), { once: true });
document.addEventListener('touchstart', () => initAudio(), { once: true });

function playCardSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const bufLen = Math.floor(audioCtx.sampleRate * 0.09);
  const buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = (Math.random()*2-1) * Math.pow(1 - i/bufLen, 3);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'highpass'; filt.frequency.value = 1800;
  const gain = audioCtx.createGain(); gain.gain.value = 0.14;
  src.connect(filt).connect(gain).connect(audioCtx.destination);
  src.start(t); src.stop(t + 0.12);
}

function playChipSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.045].forEach((offset, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 2100 + i * 500;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, t + offset);
    gain.gain.linearRampToValueAtTime(0.09, t + offset + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.07);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + offset); osc.stop(t + offset + 0.09);
  });
}

function playWinSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, t + i * 0.08);
    gain.gain.linearRampToValueAtTime(0.11, t + i * 0.08 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.4);
  });
}

let sndBoardLen = 0;
let sndBoard2Len = 0;
let sndBets = {};
let sndPhase = null;
let sndHandNumber = 0;

function playSoundsForState(s) {
  if (!s) return;
  if (s.handNumber !== sndHandNumber) {
    sndHandNumber = s.handNumber;
    sndBoardLen = 0; sndBoard2Len = 0; sndBets = {};
  }
  const bl = s.board.length;
  const b2l = s.board2 ? s.board2.length : 0;
  if (bl > sndBoardLen) playCardSound();
  if (b2l > sndBoard2Len) playCardSound();
  sndBoardLen = bl; sndBoard2Len = b2l;

  let chipPlayed = false;
  for (const p of s.players) {
    const prev = sndBets[p.id] ?? 0;
    if (!chipPlayed && p.bet > prev) { playChipSound(); chipPlayed = true; }
    sndBets[p.id] = p.bet;
  }

  if (s.phase === 'showdown' && sndPhase !== 'showdown') playWinSound();
  sndPhase = s.phase;
}

function getClientId() {
  let id = localStorage.getItem('poker_client_id');
  if (!id) {
    id = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('poker_client_id', id);
  }
  return id;
}
const CLIENT_ID = getClientId();

const RANK_SYM = { s:'♠', h:'♥', d:'♦', c:'♣' };
const cardHTML = (c, isNew = false) => {
  if (!c || c === '??') return `<div class="card back"></div>`;
  const r = c[0] === 'T' ? '10' : c[0];
  const s = c[1];
  const red = (s === 'h' || s === 'd') ? 'red' : '';
  return `<div class="card ${red} ${isNew ? 'new' : ''}"><span class="r">${r}</span><span class="s">${RANK_SYM[s]}</span></div>`;
};

/* ══════════ LOBBY ══════════ */
function msg(t) { $('lobby-msg').textContent = t; }
$('btn-create').onclick = () => {
  initAudio();
  myName = $('in-name').value.trim();
  if (!myName) return msg('Please enter your name.');
  socket.emit('create_room', { name: myName, clientId: CLIENT_ID }, (res) => {
    if (!res.ok) return msg(res.err);
    localStorage.setItem('poker_name', myName);
    enterGame(res.code, res.id);
    showShareModal(res.code);
  });
};
$('btn-join').onclick = () => {
  initAudio();
  myName = $('in-name').value.trim();
  if (!myName) return msg('Please enter your name.');
  const code = $('in-code').value.toUpperCase().trim();
  if (code.length !== 4) return msg('Code must be 4 characters.');
  socket.emit('join_room', { code, name: myName, clientId: CLIENT_ID }, (res) => {
    if (!res.ok) return msg(res.err);
    localStorage.setItem('poker_name', myName);
    enterGame(res.code, res.id);
  });
};
$('in-code').addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
$('in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
$('in-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });

function enterGame(code, id) {
  CODE = code; ME = id;
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  history.replaceState(null, '', '?room=' + code);
}

window.addEventListener('load', () => {
  const saved = localStorage.getItem('poker_name');
  if (saved) {
    if ($('in-name')) $('in-name').value = saved;
    if ($('quick-name')) $('quick-name').value = saved;
    myName = saved;
  }

  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    const code = urlRoom.toUpperCase();
    $('lobby-full').classList.add('hidden');
    $('lobby-quick').classList.remove('hidden');
    $('quick-code').textContent = code;
    socket.emit('peek_room', { code }, (res) => {
      if (res.ok) {
        if (res.minBuyin > 0) {
          $('quick-hint').textContent = `Auto buy-in: ${res.minBuyin} · Blinds ${res.sb}/${res.bb}`;
          $('quick-buyin').value = res.minBuyin;
          $('quick-buyin-wrap').style.display = 'none';
        } else {
          $('quick-hint').textContent = `Choose an amount · Blinds ${res.sb}/${res.bb}`;
          $('quick-buyin').value = res.bb * 50;
        }
      } else {
        $('quick-hint').textContent = res.err || 'Table not found.';
      }
    });

    if (saved) {
      socket.emit('join_room', { code, name: saved, clientId: CLIENT_ID }, (res) => {
        if (res.ok && res.resumed) enterGame(res.code, res.id);
      });
    }
  }
});

$('btn-quick-join').onclick = () => {
  const code = new URLSearchParams(location.search).get('room');
  if (!code) return;
  const name = ($('quick-name').value || '').trim();
  if (!name) return msg('Please enter your name.');
  const wrap = $('quick-buyin-wrap');
  const autoBuy = wrap.style.display === 'none';
  const amount = autoBuy ? null : Math.floor(+$('quick-buyin').value);
  if (!autoBuy && (!amount || amount <= 0)) return msg('Enter a valid buy-in amount.');
  
  $('btn-quick-join').disabled = true;
  socket.emit('join_room', { code: code.toUpperCase(), name, clientId: CLIENT_ID }, (res) => {
    if (!res.ok) {
      $('btn-quick-join').disabled = false;
      return msg(res.err);
    }
    localStorage.setItem('poker_name', name);
    myName = name;
    enterGame(res.code, res.id);
    if (!autoBuy && amount) {
      socket.emit('request_buyin', { amount });
      toast('Buy-in requested — waiting for admin.');
    }
  });
};
$('btn-quick-cancel').onclick = () => {
  history.replaceState(null, '', location.pathname);
  location.reload();
};

/* ══════════ STATE ══════════ */
socket.on('state', (state) => {
  if (S && state.handNumber !== S.handNumber) {
    // Reset board length trackers on new hand to ensure new card animations trigger properly
    prevBoardLen = 0;
    prevBoard2Len = 0;
  }
  S = state;
  if (!ME && myName) {
    const me = state.players.find(p => p.name === myName);
    if (me) ME = me.id;
  }
  playSoundsForState(state);
  render();
});

socket.on('toast', (t) => toast(t));

socket.on('game_ended', (state) => {
  S = state;
  closeDrawer();
  render();
  showFinalLedger();
});

/* ══════════ SHARE MODAL ══════════ */
function showShareModal(code) {
  const url = location.origin + '/?room=' + code;
  $('share-url').value = url;
  $('modal-share').classList.remove('hidden');
  if (navigator.share) $('share-native').classList.remove('hidden');
  else $('share-native').classList.add('hidden');
}
$('share-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('share-url').value); toast('Link copied!'); } catch {}
};
$('share-native').onclick = async () => {
  try { await navigator.share({ title: 'Join my poker table', url: $('share-url').value }); } catch {}
};
$('share-close').onclick = () => $('modal-share').classList.add('hidden');

/* ══════════ DRAWER ══════════ */
const panel = $('panel');
const overlay = $('panel-overlay');
function openDrawer()  { panel.classList.add('open'); overlay.classList.add('open'); }
function closeDrawer() { panel.classList.remove('open'); overlay.classList.remove('open'); }
$('btn-menu').onclick = openDrawer;
$('btn-drawer-close').onclick = closeDrawer;
overlay.onclick = closeDrawer;

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('pane-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'ledger') renderLedger();
  };
});

/* ══════════ TOASTS ══════════ */
function toast(t) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = t;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

/* ══════════ SHARE ══════════ */
$('btn-share').onclick = async () => {
  if (!CODE) return;
  const url = location.origin + '/?room=' + CODE;
  try {
    if (navigator.share) await navigator.share({ title: 'Join my poker table', url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied!'); }
  } catch {
    try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); } catch {}
  }
};

/* ══════════ FULLSCREEN ══════════ */
$('btn-fullscreen').onclick = () => {
  const elem = document.documentElement;
  if (!document.fullscreenElement) {
    if (elem.requestFullscreen) elem.requestFullscreen();
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
  }
};

/* ══════════ ADMIN BUY-IN POPUP QUEUE ══════════ */
let approveQueue = [];
socket.on('buyin_request_popup', (data) => { approveQueue.push(data); maybeShowApprove(); });
function maybeShowApprove() {
  if (!$('modal-approve').classList.contains('hidden')) return;
  if (approveQueue.length === 0) return;
  const next = approveQueue[0];
  $('approve-name').textContent = next.playerName;
  $('approve-amount').textContent = next.amount;
  $('approve-sub').textContent = next.isFirst ? 'First buy-in for this player.' : 'Rebuy — no minimum applies.';
  $('modal-approve').dataset.playerId = next.playerId;
  $('approve-accept').disabled = false;
  $('approve-reject').disabled = false;
  $('modal-approve').classList.remove('hidden');
}
function closeApproveModal() {
  $('modal-approve').classList.add('hidden');
  setTimeout(maybeShowApprove, 120);
}
$('approve-accept').onclick = () => {
  $('approve-accept').disabled = true;
  $('approve-reject').disabled = true;
  const id = $('modal-approve').dataset.playerId;
  socket.emit('admin_resolve_buyin', { playerId: id, approve: true });
  approveQueue.shift(); closeApproveModal();
};
$('approve-reject').onclick = () => {
  $('approve-accept').disabled = true;
  $('approve-reject').disabled = true;
  const id = $('modal-approve').dataset.playerId;
  socket.emit('admin_resolve_buyin', { playerId: id, approve: false });
  approveQueue.shift(); closeApproveModal();
};
$('approve-later').onclick = () => {
  const first = approveQueue.shift();
  approveQueue.push(first); closeApproveModal();
};

/* ══════════ RENDER ══════════ */
function render() {
  if (!S) return;
  const me = S.players.find(p => p.id === ME);

  $('tb-code').textContent = S.code;
  $('tb-blinds').textContent = `${S.settings.sb}/${S.settings.bb}`;
  $('tb-hand').textContent = S.phase === 'ended' ? 'Ended' : `#${S.handNumber} · ${S.phase}`;
  $('tb-you').textContent = me ? `${me.name} · ${me.chips}` : '–';
  $('tb-paused').classList.toggle('hidden', !S.paused);
  $('btn-pause').textContent = S.paused ? '▶ Resume' : '⏸ Pause';

  renderTableMessage();
  renderBoard();
  renderSeats();

  if (S.turnId !== lastTurnId) {
    lastTurnId = S.turnId;
    if (S.turnId === ME && window.matchMedia('(max-width: 880px)').matches) closeDrawer();
  }

  renderPlayerList();
  renderPending();
  renderAdminSettings();
  renderLog();
  renderActionBar();
  if ($('pane-ledger').classList.contains('active')) renderLedger();
  checkBalanceModals();

  const pending = me && me.pendingBuyin != null;
  $('btn-rebuy').textContent = pending ? `Awaiting admin…` : 'Buy-in';
  $('btn-rebuy').disabled = !!pending;
  $('btn-rebuy-top').title = pending ? 'Awaiting approval' : 'Buy-in';
}

function renderTableMessage() {
  const el = $('table-message');
  const show = (S.phase === 'showdown' || S.phase === 'ended') && S.winSummary;
  if (show) {
    el.innerHTML = `<span>🏆</span><span>${escapeHTML(S.winSummary)}</span>`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

let lastPot = 0;
let prevBoardLen = 0;
let prevBoard2Len = 0;

function renderBoard() {
  const isNew1 = S.board.length > prevBoardLen;
  const isNew2 = S.board2 && S.board2.length > prevBoard2Len;

  $('board').innerHTML = S.board.map((c, i) => cardHTML(c, isNew1 && i === S.board.length - 1)).join('');
  
  if (S.board2 && S.board2.length) {
    $('board2-wrap').classList.remove('hidden');
    $('board2').innerHTML = S.board2.map((c, i) => cardHTML(c, isNew2 && i === S.board2.length - 1)).join('');
  } else {
    $('board2-wrap').classList.add('hidden');
  }

  prevBoardLen = S.board.length;
  prevBoard2Len = S.board2 ? S.board2.length : 0;

  if (S.pot > 0) {
    $('pot-display').textContent = `POT · ${S.pot}`;
    $('pot-display').classList.remove('hidden');
    if (S.pot !== lastPot) {
      $('pot-display').classList.remove('pot-pulse');
      void $('pot-display').offsetWidth;
      $('pot-display').classList.add('pot-pulse');
      lastPot = S.pot;
    }
  } else {
    $('pot-display').classList.add('hidden');
    lastPot = 0;
  }
}

function seatPos(i, n) {
  const angleDeg = 90 + (360 / n) * i;
  const angle = (angleDeg * Math.PI) / 180;
  const isMobile = window.matchMedia('(max-width: 880px)').matches;
  const rx = isMobile ? 40 : 42;
  const ryBase = isMobile ? 30 : 38;
  const ry = i === 0 ? ryBase * 0.80 : ryBase;
  return { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
}

function renderSeats() {
  const seats = $('seats');
  seats.classList.toggle('paused', S.paused);
  seats.innerHTML = '';

  let players = S.players.filter(p => p.seated);
  if (ME) {
    const idx = players.findIndex(p => p.id === ME);
    if (idx > 0) players = [...players.slice(idx), ...players.slice(0, idx)];
  }
  const n = players.length;
  const timerSecs = S.settings.timer;
  const inHandPhase = ['preflop','flop','turn','river'].includes(S.phase);

  players.forEach((p, i) => {
    const pos = seatPos(i, n);
    const d = document.createElement('div');
    d.className = 'seat';
    if (p.id === ME) d.classList.add('hero');
    if (p.isTurn) d.classList.add('turn');
    if (p.folded) d.classList.add('folded');
    if (p.isAdmin) d.classList.add('admin');
    if (p.isWinner && (S.phase === 'showdown' || S.phase === 'ended')) d.classList.add('winner');
    d.style.left = pos.x + '%';
    d.style.top = pos.y + '%';

    const badges = [];
    if (p.id === ME) badges.push('YOU');
    if (p.away) badges.push('AWAY');
    if (p.allIn) badges.push('ALL-IN');

    const showTimer = p.isTurn && inHandPhase && timerSecs > 0 && !S.paused;

    let rankLabel = '';
    if (p.id === ME && !p.folded) {
      if (p.handRank) rankLabel = p.handRank;
      else if (p.preflop && S.phase === 'preflop') rankLabel = p.preflop;
    } else if (p.revealed && p.handRank) {
      rankLabel = p.handRank;
    }

    const winBadge = (p.lastWin > 0 && (S.phase === 'showdown' || S.phase === 'ended'))
      ? `<span class="win-badge">+${p.lastWin}</span>` : '';

    d.innerHTML = `
      <div class="badge">${badges.join(' · ')}</div>
      <div class="name">${escapeHTML(p.name)}</div>
      <div class="chips">${p.chips}${winBadge}</div>
      <div class="hole">${p.hole.map(c => cardHTML(c)).join('')}</div>
      ${rankLabel ? `<div class="seat-rank">${escapeHTML(rankLabel)}</div>` : ''}
      ${p.bet > 0 ? `<div class="bet">${p.bet}</div>` : ''}
      <div class="last">${p.lastAction || ''}</div>
      ${!p.connected ? '<div class="offline">offline</div>' : ''}
      ${showTimer ? `<div class="timer-bar" style="animation-duration:${timerSecs}s"></div>` : ''}
    `;
    seats.appendChild(d);
  });
}

function renderPlayerList() {
  const list = $('player-list');
  list.innerHTML = '';
  $('seat-count').textContent = `(${S.players.length}/${S.settings.maxSeats})`;
  for (const p of S.players) {
    const row = document.createElement('div');
    row.className = 'prow' + (p.id === ME ? ' you' : '');
    let status = '';
    if (!p.seated) status = '<span class="tag">left</span>';
    else if (p.away) status = '<span class="tag away">away</span>';
    else if (p.folded) status = '<span class="tag fold">folded</span>';
    else if (p.allIn) status = '<span class="tag">all-in</span>';
    else if (p.inHand) status = '<span class="tag">in hand</span>';
    row.innerHTML = `
      <div class="pname">${escapeHTML(p.name)} ${p.isAdmin ? '👑' : ''}${status}</div>
      <div class="pchips">${p.chips}${p.lastWin > 0 && S.phase === 'showdown' ? ` <span style="color:var(--green);font-size:11px">+${p.lastWin}</span>` : ''}</div>
      <div class="pstatus">${p.leaveAfterHand ? 'leaving after hand…' : p.pendingBuyin != null ? `requested buy-in ${p.pendingBuyin}` : ''}</div>
    `;
    list.appendChild(row);
  }
}

function renderPending() {
  const wrap = $('pending-wrap');
  const cont = $('pending-list');
  const amIAdmin = S.adminId === ME;
  const pending = S.players.filter(p => p.pendingBuyin != null);
  if (amIAdmin && pending.length) {
    wrap.classList.remove('hidden');
    cont.innerHTML = '';
    for (const p of pending) {
      const d = document.createElement('div');
      d.className = 'pend-item';
      d.innerHTML = `
        <div>${escapeHTML(p.name)}</div>
        <div class="amt">${p.pendingBuyin}</div>
        <div><button class="ok">✓</button><button class="no">✕</button></div>`;
      d.querySelector('.ok').onclick = () => socket.emit('admin_resolve_buyin', { playerId: p.id, approve: true });
      d.querySelector('.no').onclick = () => socket.emit('admin_resolve_buyin', { playerId: p.id, approve: false });
      cont.appendChild(d);
    }
  } else {
    wrap.classList.add('hidden');
  }
  $('admin-notice').classList.toggle('hidden', S.adminId === ME);
}

function renderAdminSettings() {
  const s = S.settings;
  if (document.activeElement !== $('set-bb')) $('set-bb').value = s.bb;
  if (document.activeElement !== $('set-min')) $('set-min').value = s.minBuyin;
  if (document.activeElement !== $('set-ante')) $('set-ante').value = s.ante;
  if (document.activeElement !== $('set-timer')) $('set-timer').value = s.timer;
  if (document.activeElement !== $('set-maxseats')) $('set-maxseats').value = s.maxSeats;
  $('set-sb').value = s.sb;
  $('btn-rit').style.background = S.runItTwiceArmed ? 'var(--gold)' : '';
  $('btn-rit').style.color = S.runItTwiceArmed ? '#221800' : '';
  $('btn-bomb').style.background = S.bombNext ? 'var(--gold)' : '';
  $('btn-bomb').style.color = S.bombNext ? '#221800' : '';
}

$('set-bb').addEventListener('input', () => {
  const bb = Math.floor(+$('set-bb').value) || 0;
  $('set-sb').value = Math.max(1, Math.floor(bb / 2));
});

$('btn-save-settings').onclick = () => {
  socket.emit('admin_settings', {
    bb: +$('set-bb').value,
    minBuyin: Math.max(0, +$('set-min').value),
    ante: +$('set-ante').value,
    timer: +$('set-timer').value,
    maxSeats: +$('set-maxseats').value
  });
  toast('Settings saved');
};
$('btn-bomb').onclick = () => socket.emit('admin_bomb');
$('btn-rit').onclick  = () => socket.emit('admin_rit');
$('btn-pause').onclick = () => socket.emit('admin_pause');
$('btn-end').onclick = () => {
  if (confirm('End the game? It will stop after the current hand finishes.')) {
    socket.emit('admin_end'); closeDrawer();
  }
};

function renderLog() {
  $('log').innerHTML = S.log.map(l => `<div>${escapeHTML(l)}</div>`).join('');
}

/* ══════════ ACTION BAR ══════════ */
function renderActionBar() {
  const bar = $('actions');
  bar.innerHTML = '';
  const me = S.players.find(p => p.id === ME);

  if (S.phase === 'ended') { bar.innerHTML = '<span class="hint">■ Game has ended.</span>'; return; }
  if (S.paused) { bar.innerHTML = '<span class="hint">⏸ Table paused by admin. Waiting for resume…</span>'; return; }

  if (S.phase === 'rit_vote') {
    if (!S.ritVotes || !(ME in S.ritVotes)) {
      bar.innerHTML = '<span class="hint">Players are deciding to run it twice...</span>';
      return;
    }
    const myVote = S.ritVotes[ME];
    if (myVote === null) {
      bar.appendChild(el('span', '<span class="act-info">Pot is large — run it twice?</span>'));
      bar.appendChild(btn('Yes 🔁', () => socket.emit('vote_rit', { agree: true }), 'primary'));
      bar.appendChild(btn('No', () => socket.emit('vote_rit', { agree: false }), 'danger'));
    } else {
      const waiting = Object.values(S.ritVotes).filter(v => v === null).length;
      bar.innerHTML = `<span class="hint">Waiting for ${waiting} more player(s)...</span>`;
    }
    return;
  }

  if (S.phase === 'showdown') {
    if (me && me.atShowdown && !me.revealed) {
      const b = document.createElement('button');
      b.className = 'btn reveal-btn';
      b.textContent = '👁 Show my hand';
      b.onclick = () => socket.emit('reveal_hand');
      bar.appendChild(b);
    } else {
      bar.innerHTML = '<span class="hint">Hand complete — next hand starting soon…</span>';
    }
    return;
  }
  if (S.phase === 'dealing') { bar.innerHTML = '<span class="hint">Dealing…</span>'; return; }

  if (S.phase === 'waiting') {
    if (S.handNumber === 0 && S.adminId === ME) {
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = '▶ Start game';
      b.onclick = () => socket.emit('admin_start_game');
      bar.appendChild(b);
    } else if (S.handNumber === 0) {
      bar.innerHTML = '<span class="hint">Waiting for admin to start the game…</span>';
    } else {
      bar.innerHTML = '<span class="hint">Dealing next hand…</span>';
    }
    return;
  }

  if (!me || !me.inHand || me.folded || me.allIn) {
    bar.innerHTML = '<span class="hint">Waiting…</span>';
    return;
  }
  if (S.turnId !== ME) { bar.innerHTML = '<span class="hint">Waiting for your turn…</span>'; return; }

  const toCall = S.currentBet - me.bet;
  const minRaiseTo = S.currentBet + S.minRaise;
  const maxRaiseTo = me.chips + me.bet;

  if (me.handRank || me.preflop) {
    bar.appendChild(el('span', `<span class="act-info">You have <b>${escapeHTML(me.handRank || me.preflop)}</b></span>`));
  }

  bar.appendChild(btn('Fold', () => socket.emit('player_action', { type: 'fold' }), 'danger'));

  if (toCall <= 0) {
    bar.appendChild(btn('Check', () => socket.emit('player_action', { type: 'check' })));
  } else {
    const callAmt = Math.min(toCall, me.chips);
    bar.appendChild(btn(`Call ${callAmt}`, () => socket.emit('player_action', { type: 'call' })));
  }

  const isPostflop = S.phase !== 'preflop';
  const isUnopened = S.currentBet === 0;
  const raiseLabel = (isPostflop && isUnopened) ? 'Bet' : 'Raise';
  const defaultVal = (isPostflop && isUnopened) ? S.minRaise : Math.min(minRaiseTo, maxRaiseTo);

  const rg = document.createElement('div');
  rg.className = 'raise-group';
  const input = document.createElement('input');
  input.type = 'number'; input.inputMode = 'numeric'; input.step = 1;
  input.min = isUnopened ? S.minRaise : minRaiseTo;
  input.max = maxRaiseTo;
  input.value = defaultVal;
  input.addEventListener('input', () => input.value = input.value.replace(/[^\d]/g, ''));
  input.addEventListener('blur', () => {
    let v = Math.floor(+input.value) || defaultVal;
    v = Math.max(input.min, Math.min(maxRaiseTo, v));
    input.value = v;
  });

  const raiseBtn = document.createElement('button');
  raiseBtn.className = 'btn green';
  raiseBtn.textContent = raiseLabel;
  raiseBtn.onclick = () => {
    let v = Math.floor(+input.value) || defaultVal;
    v = Math.max(input.min, Math.min(maxRaiseTo, v));
    socket.emit('player_action', { type: 'raise', amount: v });
  };
  rg.appendChild(input); rg.appendChild(raiseBtn);
  bar.appendChild(rg);
  bar.appendChild(btn('All-in', () => socket.emit('player_action', { type: 'raise', amount: maxRaiseTo }), 'primary'));
}

function el(tag, html) { const e = document.createElement(tag); e.innerHTML = html; return e; }
function btn(label, cb, variant) {
  const b = document.createElement('button');
  b.className = 'btn' + (variant ? ' ' + variant : '');
  b.textContent = label; b.onclick = cb;
  return b;
}

/* ══════════ BALANCE MODALS (first buy-in + bust) ══════════ */
let promptedFirstBuyin = false;
let promptedBust = false;

function checkBalanceModals() {
  const me = S.players.find(p => p.id === ME);
  if (!me || S.phase === 'ended') return;

  const buyinOpen = !$('modal-buyin').classList.contains('hidden');
  const oocOpen = !$('modal-outofchips').classList.contains('hidden');

  if (me.chips > 0) {
    promptedFirstBuyin = false; promptedBust = false;
    if (oocOpen) $('modal-outofchips').classList.add('hidden');
    return;
  }

  if (me.pendingBuyin || me.away) return;

  if (me.buyIns.length === 0) {
    if (S.settings.minBuyin > 0) return;
    if (!promptedFirstBuyin && !buyinOpen && !oocOpen) {
      promptedFirstBuyin = true;
      openBuyin();
    }
    return;
  }

  if (me.buyIns.length > 0) {
    if (!promptedBust && !buyinOpen && !oocOpen) {
      promptedBust = true;
      openOutOfChips();
    }
  }
}

function openOutOfChips() { $('modal-outofchips').classList.remove('hidden'); }
$('ooc-rebuy').onclick = () => {
  $('modal-outofchips').classList.add('hidden');
  promptedBust = false; openBuyin();
};
$('ooc-spectate').onclick = () => {
  $('modal-outofchips').classList.add('hidden');
  socket.emit('spectate');
  toast('Spectating. Tap Buy-in anytime to rejoin.');
};

/* ══════════ QUICK ACTIONS ══════════ */
$('btn-away').onclick = () => socket.emit('away_toggle');
$('btn-leave').onclick = () => {
  if (confirm('Leave the table after the current hand?')) {
    socket.emit('leave_after_hand'); closeDrawer();
  }
};

/* ══════════ BUY-IN ══════════ */
$('btn-rebuy').onclick = () => openBuyin();
$('btn-rebuy-top').onclick = () => openBuyin();

function openBuyin() {
  if (!S) return;
  const me = S.players.find(p => p.id === ME);
  if (me && me.pendingBuyin != null) { toast('Your buy-in is awaiting admin approval.'); return; }
  const isFirst = !me || me.buyIns.length === 0;
  const minSet = S.settings.minBuyin > 0;
  $('buyin-info').textContent = isFirst
    ? (minSet ? `Min initial buy-in: ${S.settings.minBuyin}` : 'Choose your first buy-in amount')
    : 'Rebuy (no minimum applies)';
  const amounts = isFirst
    ? (minSet
        ? [S.settings.minBuyin, S.settings.minBuyin * 2, S.settings.minBuyin * 5]
        : [S.settings.bb * 50, S.settings.bb * 100, S.settings.bb * 200])
    : [S.settings.bb * 50, S.settings.bb * 100, S.settings.bb * 200];
  $('buyin-quick').innerHTML = amounts.map(a => `<button data-a="${a}">${a}</button>`).join('');
  $('buyin-quick').querySelectorAll('button').forEach(b => b.onclick = () => $('buyin-amount').value = b.dataset.a);
  $('buyin-amount').value = amounts[0];
  $('buyin-send').disabled = false;
  $('modal-buyin').classList.remove('hidden');
}
$('buyin-cancel').onclick = () => $('modal-buyin').classList.add('hidden');
$('buyin-send').onclick = () => {
  const amt = Math.floor(+$('buyin-amount').value);
  if (!amt || amt <= 0) return toast('Enter a whole-number amount');
  $('buyin-send').disabled = true;
  socket.emit('request_buyin', { amount: amt });
  $('modal-buyin').classList.add('hidden');
  toast('Buy-in requested — waiting for admin.');
};

/* ══════════ LEDGER ══════════ */
function renderLedger() {
  if (!S) return;
  const rows = S.players.map(p => {
    const buyin = p.buyIns.reduce((a, b) => a + b, 0);
    const pl = p.chips - buyin;
    return { name: p.name, buyin, chips: p.chips, pl };
  });
  $('ledger').innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Buy-in</th><th>Chips</th><th>P/L</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td>${escapeHTML(r.name)}</td><td>${r.buyin}</td><td>${r.chips}</td>
        <td class="${r.pl >= 0 ? 'pos' : 'neg'}">${r.pl >= 0 ? '+' : ''}${r.pl}</td></tr>
      `).join('')}</tbody>
    </table>`;
}

function showFinalLedger() {
  const rows = S.players.map(p => {
    const buyin = p.buyIns.reduce((a, b) => a + b, 0);
    const pl = p.chips - buyin;
    return { name: p.name, buyin, chips: p.chips, pl };
  });
  $('ledger-final').innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Buy-in</th><th>Final chips</th><th>Profit / Loss</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td>${escapeHTML(r.name)}</td><td>${r.buyin}</td><td>${r.chips}</td>
        <td class="${r.pl >= 0 ? 'pos' : 'neg'}">${r.pl >= 0 ? '+' : ''}${r.pl}</td></tr>
      `).join('')}</tbody>
    </table>
    <p class="muted" style="margin-top:12px">Hands played: ${S.handNumber}</p>
  `;
  $('modal-ledger').classList.remove('hidden');
}
$('ledger-close').onclick = () => $('modal-ledger').classList.add('hidden');
$('ledger-copy').onclick = async () => {
  const txt = S.players.map(p => {
    const buyin = p.buyIns.reduce((a, b) => a + b, 0);
    const pl = p.chips - buyin;
    return `${p.name}: buyin ${buyin}, final ${p.chips}, P/L ${pl >= 0 ? '+' : ''}${pl}`;
  }).join('\n');
  try { await navigator.clipboard.writeText(txt); toast('Ledger copied'); } catch {}
};

/* ══════════ UTILS ══════════ */
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

window.addEventListener('resize', () => { if (S) renderSeats(); });