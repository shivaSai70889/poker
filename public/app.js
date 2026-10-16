const $ = (id) => document.getElementById(id);
const socket = io();

let ME = null;
let CODE = null;
let S = null;
let myName = '';
let lastTurnId = null;

/* ── Persistent client id (so reload = same player) ── */
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
const cardHTML = (c) => {
  if (!c || c === '??') return `<div class="card back"></div>`;
  const r = c[0] === 'T' ? '10' : c[0];
  const s = c[1];
  const red = (s === 'h' || s === 'd') ? 'red' : '';
  return `<div class="card ${red}"><span class="r">${r}</span><span class="s">${RANK_SYM[s]}</span></div>`;
};

/* ══════════ LOBBY ══════════ */
function msg(t) { $('lobby-msg').textContent = t; }

$('btn-create').onclick = () => {
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

/* Restore name from localStorage */
window.addEventListener('load', () => {
  const saved = localStorage.getItem('poker_name');
  if (saved) {
    if ($('in-name')) $('in-name').value = saved;
    if ($('quick-name')) $('quick-name').value = saved;
    myName = saved;
  }

  // URL room → quick join flow OR auto-resume
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    const code = urlRoom.toUpperCase();
    // Show quick-join UI
    $('lobby-full').classList.add('hidden');
    $('lobby-quick').classList.remove('hidden');
    $('quick-code').textContent = code;
    // Peek room info
    socket.emit('peek_room', { code }, (res) => {
      if (res.ok) {
        $('quick-hint').textContent = `Min initial buy-in: ${res.minBuyin} · Blinds ${res.sb}/${res.bb}`;
        $('quick-buyin').value = res.minBuyin;
      } else {
        $('quick-hint').textContent = res.err || 'Table not found.';
      }
    });

    // If we already have a session for this room, auto-resume
    if (ME || localStorage.getItem('poker_name')) {
      // Try auto-resume silently. If it succeeds we jump straight into game.
      const guess = saved || '';
      if (guess) {
        socket.emit('join_room', { code, name: guess, clientId: CLIENT_ID }, (res) => {
          if (res.ok && res.resumed) {
            localStorage.setItem('poker_name', guess);
            enterGame(res.code, res.id);
          }
          // else: stay on lobby (quick-join) so they can enter name / buy-in
        });
      }
    }
  }
});

/* Quick join (from invite link) */
$('btn-quick-join').onclick = () => {
  const code = new URLSearchParams(location.search).get('room');
  if (!code) return;
  const name = ($('quick-name').value || '').trim();
  const amount = Math.floor(+$('quick-buyin').value);
  if (!name) return msg('Please enter your name.');
  if (!amount || amount <= 0) return msg('Enter a valid buy-in amount.');
  socket.emit('join_room', { code: code.toUpperCase(), name, clientId: CLIENT_ID }, (res) => {
    if (!res.ok) return msg(res.err);
    localStorage.setItem('poker_name', name);
    myName = name;
    enterGame(res.code, res.id);
    // Then request buy-in
    socket.emit('request_buyin', { amount });
    toast('Buy-in requested — waiting for admin.');
  });
};
$('btn-quick-cancel').onclick = () => {
  history.replaceState(null, '', location.pathname);
  location.reload();
};

/* ══════════ STATE ══════════ */
socket.on('state', (state) => {
  S = state;
  if (!ME && myName) {
    const me = state.players.find(p => p.name === myName);
    if (me) ME = me.id;
  }
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

/* ══════════ ADMIN BUY-IN POPUP QUEUE ══════════ */
let approveQueue = [];

socket.on('buyin_request_popup', (data) => {
  approveQueue.push(data);
  maybeShowApprove();
});

function maybeShowApprove() {
  if (!$('modal-approve').classList.contains('hidden')) return;
  if (approveQueue.length === 0) return;
  const next = approveQueue[0];
  $('approve-name').textContent = next.playerName;
  $('approve-amount').textContent = next.amount;
  $('approve-sub').textContent = next.isFirst
    ? 'First buy-in for this player.'
    : 'Rebuy — no minimum applies.';
  $('modal-approve').dataset.playerId = next.playerId;
  $('modal-approve').classList.remove('hidden');
}
function closeApproveModal() {
  $('modal-approve').classList.add('hidden');
  setTimeout(maybeShowApprove, 120);
}
$('approve-accept').onclick = () => {
  const id = $('modal-approve').dataset.playerId;
  socket.emit('admin_resolve_buyin', { playerId: id, approve: true });
  approveQueue.shift();
  closeApproveModal();
};
$('approve-reject').onclick = () => {
  const id = $('modal-approve').dataset.playerId;
  socket.emit('admin_resolve_buyin', { playerId: id, approve: false });
  approveQueue.shift();
  closeApproveModal();
};
$('approve-later').onclick = () => {
  const first = approveQueue.shift();
  approveQueue.push(first);
  closeApproveModal();
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

  renderBoard();
  renderSeats();

  // Auto-close mobile drawer when it becomes our turn
  if (S.turnId !== lastTurnId) {
    lastTurnId = S.turnId;
    if (S.turnId === ME && window.matchMedia('(max-width: 880px)').matches) {
      closeDrawer();
    }
  }

  renderPlayerList();
  renderPending();
  renderAdminSettings();
  renderLog();
  renderActionBar();
  if ($('pane-ledger').classList.contains('active')) renderLedger();

  const pending = me && me.pendingBuyin != null;
  $('btn-rebuy').textContent = pending ? `Awaiting admin…` : 'Buy-in';
  $('btn-rebuy').disabled = !!pending;
  $('btn-rebuy-top').title = pending ? 'Awaiting approval' : 'Buy-in';
}

function renderBoard() {
  $('board').innerHTML = S.board.map(cardHTML).join('');
  if (S.board2 && S.board2.length) {
    $('board2-wrap').classList.remove('hidden');
    $('board2').innerHTML = S.board2.map(cardHTML).join('');
  } else {
    $('board2-wrap').classList.add('hidden');
  }
  if (S.pot > 0) {
    $('pot-display').textContent = `POT · ${S.pot}`;
    $('pot-display').classList.remove('hidden');
  } else {
    $('pot-display').classList.add('hidden');
  }
}

function seatPos(i, n) {
  const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
  const isMobile = window.matchMedia('(max-width: 880px)').matches;
  const rx = isMobile ? 40 : 42;
  const ry = isMobile ? 34 : 38;
  return { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
}

function renderSeats() {
  const seats = $('seats');
  seats.classList.toggle('paused', S.paused);
  seats.innerHTML = '';
  const players = S.players.filter(p => p.seated);
  const n = players.length;
  const timerSecs = S.settings.timer;
  const inHandPhase = ['preflop','flop','turn','river'].includes(S.phase);

  players.forEach((p, i) => {
    const pos = seatPos(i, n);
    const d = document.createElement('div');
    d.className = 'seat';
    if (p.isTurn) d.classList.add('turn');
    if (p.folded) d.classList.add('folded');
    if (p.isAdmin) d.classList.add('admin');
    d.style.left = pos.x + '%';
    d.style.top = pos.y + '%';
    const badges = [];
    if (p.id === ME) badges.push('YOU');
    if (p.away) badges.push('AWAY');
    if (p.allIn) badges.push('ALL-IN');

    // Show timer bar only on active turn during a hand
    const showTimer = p.isTurn && inHandPhase && timerSecs > 0 && !S.paused;

    d.innerHTML = `
      <div class="badge">${badges.join(' · ')}</div>
      <div class="name">${escapeHTML(p.name)}</div>
      <div class="chips">${p.chips}</div>
      <div class="hole">${p.hole.map(cardHTML).join('')}</div>
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
      <div class="pchips">${p.chips}</div>
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
    minBuyin: +$('set-min').value,
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
    socket.emit('admin_end');
    closeDrawer();
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

  if (S.phase === 'ended') {
    bar.innerHTML = '<span class="hint">■ Game has ended.</span>';
    return;
  }
  if (S.paused) {
    bar.innerHTML = '<span class="hint">⏸ Table paused by admin. Waiting for resume…</span>';
    return;
  }
  if (S.phase === 'waiting' || S.phase === 'showdown') {
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
  if (S.turnId !== ME) {
    bar.innerHTML = '<span class="hint">Waiting for your turn…</span>';
    return;
  }

  // ── Our turn ──
  const toCall = S.currentBet - me.bet;
  const minRaiseTo = S.currentBet + S.minRaise;
  const maxRaiseTo = me.chips + me.bet;

  bar.appendChild(btn('Fold', () => socket.emit('player_action', { type: 'fold' }), 'danger'));

  if (toCall <= 0) {
    bar.appendChild(btn('Check', () => socket.emit('player_action', { type: 'check' })));
  } else {
    const callAmt = Math.min(toCall, me.chips);
    bar.appendChild(btn(`Call ${callAmt}`, () => socket.emit('player_action', { type: 'call' })));
  }

  const rg = document.createElement('div');
  rg.className = 'raise-group';

  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.step = 1;
  input.min = minRaiseTo;
  input.max = maxRaiseTo;
  input.value = Math.min(minRaiseTo, maxRaiseTo);
  input.addEventListener('input', () => {
    input.value = input.value.replace(/[^\d]/g, '');
  });
  input.addEventListener('blur', () => {
    let v = Math.floor(+input.value) || minRaiseTo;
    v = Math.max(minRaiseTo, Math.min(maxRaiseTo, v));
    input.value = v;
  });

  const raiseBtn = document.createElement('button');
  raiseBtn.className = 'btn green';
  raiseBtn.textContent = 'Raise';
  raiseBtn.onclick = () => {
    let v = Math.floor(+input.value) || minRaiseTo;
    v = Math.max(minRaiseTo, Math.min(maxRaiseTo, v));
    socket.emit('player_action', { type: 'raise', amount: v });
  };

  rg.appendChild(input);
  rg.appendChild(raiseBtn);
  bar.appendChild(rg);

  bar.appendChild(btn('All-in', () => socket.emit('player_action', { type: 'raise', amount: maxRaiseTo }), 'primary'));
}

function btn(label, cb, variant) {
  const b = document.createElement('button');
  b.className = 'btn' + (variant ? ' ' + variant : '');
  b.textContent = label;
  b.onclick = cb;
  return b;
}

/* ══════════ QUICK ACTIONS ══════════ */
$('btn-away').onclick = () => socket.emit('away_toggle');
$('btn-leave').onclick = () => {
  if (confirm('Leave the table after the current hand?')) {
    socket.emit('leave_after_hand');
    closeDrawer();
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
  $('buyin-info').textContent = isFirst
    ? `Min initial buy-in: ${S.settings.minBuyin}`
    : 'Rebuy (no minimum applies)';
  const amounts = isFirst
    ? [S.settings.minBuyin, S.settings.minBuyin * 2, S.settings.minBuyin * 5]
    : [S.settings.bb * 50, S.settings.bb * 100, S.settings.bb * 200];
  $('buyin-quick').innerHTML = amounts.map(a => `<button data-a="${a}">${a}</button>`).join('');
  $('buyin-quick').querySelectorAll('button').forEach(b => b.onclick = () => $('buyin-amount').value = b.dataset.a);
  $('buyin-amount').value = amounts[0];
  $('modal-buyin').classList.remove('hidden');
}
$('buyin-cancel').onclick = () => $('modal-buyin').classList.add('hidden');
$('buyin-send').onclick = () => {
  const amt = Math.floor(+$('buyin-amount').value);
  if (!amt || amt <= 0) return toast('Enter a whole-number amount');
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
