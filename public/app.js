const $ = (id) => document.getElementById(id);
const socket = io();

let ME = null;        // my player id
let CODE = null;      // room code
let S = null;         // latest game state
let myName = '';

const RANK_SYM = { s:'♠', h:'♥', d:'♦', c:'♣' };
const cardHTML = (c) => {
  if (!c || c === '??') return `<div class="card back"></div>`;
  const r = c[0] === 'T' ? '10' : c[0];
  const s = c[1];
  const red = (s === 'h' || s === 'd') ? 'red' : '';
  return `<div class="card ${red}"><span class="r">${r}</span><span class="s">${RANK_SYM[s]}</span></div>`;
};

/* ── Lobby ── */
$('btn-create').onclick = () => {
  myName = $('in-name').value.trim();
  if (!myName) return msg('Please enter your name.');
  socket.emit('create_room', { name: myName }, (res) => {
    if (!res.ok) return msg(res.err);
    enterGame(res.code, res.id);
  });
};
$('btn-join').onclick = () => {
  myName = $('in-name').value.trim();
  if (!myName) return msg('Please enter your name.');
  const code = $('in-code').value.toUpperCase().trim();
  if (code.length !== 4) return msg('Code must be 4 characters.');
  socket.emit('join_room', { code, name: myName }, (res) => {
    if (!res.ok) return msg(res.err);
    enterGame(res.code, res.id);
  });
};
$('in-code').addEventListener('input', e => e.target.value = e.target.value.toUpperCase());
function msg(t) { $('lobby-msg').textContent = t; }

function enterGame(code, id) {
  CODE = code; ME = id;
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  history.replaceState(null, '', '?room=' + code);
}

/* Auto-join via URL */
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('in-code').value = urlRoom.toUpperCase();

/* ── State updates ── */
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
  showFinalLedger();
});

function toast(t) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = t;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

/* ── Share link ── */
$('btn-share').onclick = async () => {
  const url = location.origin + '/?room=' + CODE;
  try {
    if (navigator.share) await navigator.share({ title: 'Join my poker table', url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied!'); }
  } catch {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied!');
  }
};

/* ── Tabs ── */
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('pane-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'ledger') renderLedger();
  };
});

/* ── Render ── */
function render() {
  if (!S) return;
  const me = S.players.find(p => p.id === ME);
  $('tb-code').textContent = S.code;
  $('tb-blinds').textContent = `Blinds ${S.settings.sb}/${S.settings.bb}`;
  $('tb-hand').textContent = `Hand #${S.handNumber} · ${S.phase}`;
  $('tb-you').textContent = me ? `${me.name} · ${me.chips}` : '';
  $('tb-paused').classList.toggle('hidden', !S.paused);
  $('btn-pause').textContent = S.paused ? '▶ Resume' : '⏸ Pause';

  renderBoard();
  renderSeats();
  renderPlayerList();
  renderPending();
  renderAdminSettings();
  renderLog();
  renderActionBar();
  if ($('pane-ledger').classList.contains('active')) renderLedger();
}

function renderBoard() {
  $('board').innerHTML = S.board.map(cardHTML).join('');
  if (S.board2 && S.board2.length) {
    $('board2-wrap').classList.remove('hidden');
    $('board2').innerHTML = S.board2.map(cardHTML).join('');
  } else {
    $('board2-wrap').classList.add('hidden');
  }
  $('pot-display').textContent = S.pot > 0 ? `Pot: ${S.pot}` : '';
}

function seatPos(i, n) {
  const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
  // Use ellipse with different rx / ry to fit felt
  const rx = 42, ry = 38;
  const cx = 50, cy = 50;
  return {
    x: cx + rx * Math.cos(angle),
    y: cy + ry * Math.sin(angle)
  };
}

function renderSeats() {
  const seats = $('seats');
  seats.innerHTML = '';
  const players = S.players.filter(p => p.seated);
  const n = players.length;
  players.forEach((p, i) => {
    const pos = seatPos(i, n);
    const d = document.createElement('div');
    d.className = 'seat';
    if (p.isTurn) d.classList.add('turn');
    if (p.folded) d.classList.add('folded');
    if (p.isAdmin) d.classList.add('admin');
    d.style.left = pos.x + '%';
    d.style.top = pos.y + '%';
    d.innerHTML = `
      <div class="badge">${p.id === ME ? 'YOU' : ''}${p.away ? ' · AWAY' : ''}${p.allIn ? ' · ALL-IN' : ''}</div>
      <div class="name">${escapeHTML(p.name)}</div>
      <div class="chips">${p.chips}</div>
      <div class="hole">${p.hole.map(cardHTML).join('')}</div>
      ${p.bet > 0 ? `<div class="bet">Bet ${p.bet}</div>` : ''}
      <div class="last">${p.lastAction || ''}</div>
      ${!p.connected ? '<div class="offline">offline</div>' : ''}
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
    if (p.away) status = '<span class="tag away">away</span>';
    else if (p.folded) status = '<span class="tag fold">folded</span>';
    else if (!p.seated) status = '<span class="tag">left</span>';
    else if (p.allIn) status = '<span class="tag">all-in</span>';
    else if (p.inHand) status = '<span class="tag">in hand</span>';
    row.innerHTML = `
      <div class="pname">${escapeHTML(p.name)} ${p.isAdmin ? '👑' : ''}${status}</div>
      <div class="pchips">${p.chips}</div>
      <div class="pstatus">${p.leaveAfterHand ? 'leaving…' : ''}</div>
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
      d.innerHTML = `<div>${escapeHTML(p.name)}</div><div class="amt">${p.pendingBuyin}</div>
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
  if (document.activeElement !== $('set-sb')) $('set-sb').value = s.sb;
  if (document.activeElement !== $('set-bb')) $('set-bb').value = s.bb;
  if (document.activeElement !== $('set-min')) $('set-min').value = s.minBuyin;
  if (document.activeElement !== $('set-ante')) $('set-ante').value = s.ante;
  if (document.activeElement !== $('set-timer')) $('set-timer').value = s.timer;
  if (document.activeElement !== $('set-maxseats')) $('set-maxseats').value = s.maxSeats;
  $('btn-rit').style.background = S.runItTwiceArmed ? 'var(--gold)' : '';
  $('btn-rit').style.color = S.runItTwiceArmed ? '#221800' : '';
  $('btn-bomb').style.background = S.bombNext ? 'var(--gold)' : '';
  $('btn-bomb').style.color = S.bombNext ? '#221800' : '';
}

$('btn-save-settings').onclick = () => {
  socket.emit('admin_settings', {
    sb: +$('set-sb').value,
    bb: +$('set-bb').value,
    minBuyin: +$('set-min').value,
    ante: +$('set-ante').value,
    timer: +$('set-timer').value,
    maxSeats: +$('set-maxseats').value
  });
  toast('Settings saved');
};
$('btn-next').onclick = () => socket.emit('admin_next_hand');
$('btn-bomb').onclick = () => socket.emit('admin_bomb');
$('btn-rit').onclick = () => socket.emit('admin_rit');
$('btn-pause').onclick = () => socket.emit('admin_pause');
$('btn-end').onclick = () => {
  if (confirm('End the game for everyone? The final ledger will be shown.')) socket.emit('admin_end');
};

function renderLog() {
  $('log').innerHTML = S.log.map(l => `<div>${escapeHTML(l)}</div>`).join('');
}

function renderActionBar() {
  const bar = $('actions');
  bar.innerHTML = '';
  const me = S.players.find(p => p.id === ME);
  const myTurn = S.turnId === ME && !S.paused;

  if (S.paused) { bar.innerHTML = '<span class="hint">⏸ Table paused by admin.</span>'; return; }
  if (S.phase === 'waiting' || S.phase === 'showdown') {
    if (S.adminId === ME) {
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = '▶ Deal next hand';
      btn.onclick = () => socket.emit('admin_next_hand');
      bar.appendChild(btn);
    } else {
      bar.innerHTML = '<span class="hint">Waiting for admin to deal…</span>';
    }
    return;
  }
  if (!me || !me.inHand || me.folded || me.allIn) {
    bar.innerHTML = '<span class="hint">Waiting…</span>';
    return;
  }
  if (!myTurn) { bar.innerHTML = '<span class="hint">Waiting for your turn…</span>'; return; }

  const toCall = S.currentBet - me.bet;
  const minRaiseTo = S.currentBet + S.minRaise;

  const fold = btn('Fold', () => socket.emit('player_action', { type: 'fold' }));
  fold.classList.add('danger');
  bar.appendChild(fold);

  if (toCall <= 0) {
    bar.appendChild(btn('Check', () => socket.emit('player_action', { type: 'check' })));
  } else {
    bar.appendChild(btn(`Call ${Math.min(toCall, me.chips)}`, () => socket.emit('player_action', { type: 'call' })));
  }

  const rg = document.createElement('div');
  rg.className = 'raise-group';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = minRaiseTo;
  input.max = me.chips + me.bet;
  input.value = Math.min(minRaiseTo, me.chips + me.bet);
  const raise = document.createElement('button');
  raise.className = 'btn green';
  raise.textContent = 'Raise';
  raise.onclick = () => socket.emit('player_action', { type: 'raise', amount: +input.value });
  rg.appendChild(input);
  rg.appendChild(raise);
  bar.appendChild(rg);

  const allIn = document.createElement('button');
  allIn.className = 'btn primary';
  allIn.textContent = 'All-in';
  allIn.onclick = () => socket.emit('player_action', { type: 'raise', amount: me.chips + me.bet });
  bar.appendChild(allIn);
}

function btn(label, cb) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  b.onclick = cb;
  return b;
}

/* ── Quick actions ── */
$('btn-away').onclick = () => socket.emit('away_toggle');
$('btn-leave').onclick = () => {
  if (confirm('Leave the table after the current hand?')) socket.emit('leave_after_hand');
};

/* ── Buy-in modal ── */
$('btn-rebuy').onclick = () => openBuyin();
function openBuyin() {
  const me = S.players.find(p => p.id === ME);
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
  const amt = +$('buyin-amount').value;
  if (!amt || amt <= 0) return toast('Enter an amount');
  socket.emit('request_buyin', { amount: amt });
  $('modal-buyin').classList.add('hidden');
};

/* ── Ledger ── */
function renderLedger() {
  const me = S.players.find(p => p.id === ME);
  const rows = S.players.map(p => {
    const buyin = p.buyIns.reduce((a,b)=>a+b, 0);
    const pl = p.chips - buyin;
    return { name: p.name, buyin, chips: p.chips, pl };
  });
  $('ledger').innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Buy-in</th><th>Chips</th><th>P/L</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td>${escapeHTML(r.name)}</td><td>${r.buyin}</td><td>${r.chips}</td>
        <td class="${r.pl>=0?'pos':'neg'}">${r.pl>=0?'+':''}${r.pl}</td></tr>
      `).join('')}</tbody>
    </table>`;
}

function showFinalLedger() {
  const rows = S.players.map(p => {
    const buyin = p.buyIns.reduce((a,b)=>a+b, 0);
    const pl = p.chips - buyin;
    return { name: p.name, buyin, chips: p.chips, pl };
  });
  $('ledger-final').innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Buy-in</th><th>Final chips</th><th>Profit / Loss</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td>${escapeHTML(r.name)}</td><td>${r.buyin}</td><td>${r.chips}</td>
        <td class="${r.pl>=0?'pos':'neg'}">${r.pl>=0?'+':''}${r.pl}</td></tr>
      `).join('')}</tbody>
    </table>
    <p class="muted" style="margin-top:12px">Hands played: ${S.handNumber}</p>
  `;
  $('modal-ledger').classList.remove('hidden');
}
$('ledger-close').onclick = () => $('modal-ledger').classList.add('hidden');
$('ledger-copy').onclick = async () => {
  const txt = S.players.map(p => {
    const buyin = p.buyIns.reduce((a,b)=>a+b,0);
    const pl = p.chips - buyin;
    return `${p.name}: buyin ${buyin}, final ${p.chips}, P/L ${pl>=0?'+':''}${pl}`;
  }).join('\n');
  try { await navigator.clipboard.writeText(txt); toast('Ledger copied'); } catch {}
};

/* ── Helpers ── */
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Auto-fill name from local storage for convenience
window.addEventListener('load', () => {
  const saved = localStorage.getItem('poker_name');
  if (saved && !$('in-name').value) $('in-name').value = saved;
});
$('in-name').addEventListener('change', e => localStorage.setItem('poker_name', e.target.value));