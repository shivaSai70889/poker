const express = require('http');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
const rooms = new Map();

/* ─────────────── TRUE RANDOM SHUFFLE ─────────────── */
function secureShuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RV = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return secureShuffle(d);
}
function deckFingerprint(deck) {
  return crypto.createHash('sha256').update(deck.join(',')).digest('hex').slice(0, 10);
}

/* ─────────────── HAND EVALUATION ─────────────── */
function combos(arr, k, start = 0, cur = [], out = []) {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i < arr.length; i++) { cur.push(arr[i]); combos(arr, k, i+1, cur, out); cur.pop(); }
  return out;
}
function rank5(cards) {
  const ranks = cards.map(c => RV[c[0]]).sort((a,b)=>b-a);
  const suits = cards.map(c => c[1]);
  const flush = suits.every(s => s === suits[0]);
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r]||0)+1;
  const groups = Object.entries(counts).map(([r,c])=>({r:+r,c})).sort((a,b)=> b.c-a.c || b.r-a.r);
  const uniq = [...new Set(ranks)].sort((a,b)=>b-a);
  let straight = false, sHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { straight = true; sHigh = uniq[0]; }
    else if (uniq[0] === 14 && uniq[1] === 5) { straight = true; sHigh = 5; }
  }
  if (straight && flush) return { cat: 8, ranks: [sHigh], name: 'Straight Flush' };
  if (groups[0].c === 4) return { cat: 7, ranks: [groups[0].r, groups[1].r], name: 'Four of a Kind' };
  if (groups[0].c === 3 && groups[1].c === 2) return { cat: 6, ranks: [groups[0].r, groups[1].r], name: 'Full House' };
  if (flush) return { cat: 5, ranks, name: 'Flush' };
  if (straight) return { cat: 4, ranks: [sHigh], name: 'Straight' };
  if (groups[0].c === 3) return { cat: 3, ranks: [groups[0].r, ...groups.slice(1).map(g=>g.r)], name: 'Three of a Kind' };
  if (groups[0].c === 2 && groups[1].c === 2) return { cat: 2, ranks: [groups[0].r, groups[1].r, groups[2].r], name: 'Two Pair' };
  if (groups[0].c === 2) return { cat: 1, ranks: [groups[0].r, ...groups.slice(1).map(g=>g.r)], name: 'Pair' };
  return { cat: 0, ranks, name: 'High Card' };
}
function rank7(cards) {
  if (cards.length < 5) return null;
  let best = null;
  for (const c of combos(cards, 5)) {
    const r = rank5(c);
    if (!best || cmpRank(r, best) > 0) best = r;
  }
  return best;
}
function cmpRank(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < 5; i++) {
    const d = (a.ranks[i] || 0) - (b.ranks[i] || 0);
    if (d) return d;
  }
  return 0;
}
function preflopLabel(hole) {
  if (!hole || hole.length < 2) return null;
  const r1 = hole[0][0], r2 = hole[1][0];
  const s1 = hole[0][1], s2 = hole[1][1];
  const high = RV[r1] >= RV[r2] ? r1 : r2;
  const low  = RV[r1] >= RV[r2] ? r2 : r1;
  const H = high === 'T' ? '10' : high;
  const L = low === 'T' ? '10' : low;
  if (r1 === r2) return `Pocket ${H}s`;
  return `${H}${L} ${s1 === s2 ? 'suited' : 'offsuit'}`;
}

/* ─────────────── ROOM ─────────────── */
let idCounter = 0;
const nextId = () => 'p' + (++idCounter) + Date.now().toString(36);

class Room {
  constructor(code) {
    this.code = code;
    this.adminId = null;
    this.players = new Map();
    this.settings = { bb: 2, minBuyin: 0, ante: 0, timer: 30, maxSeats: 10 };
    this.paused = false;
    this.phase = 'waiting';
    this.handNumber = 0;
    this.deck = [];
    this.deckHash = '';
    this.board = [];
    this.board2 = [];
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.turnId = null;
    this.dealerId = null;
    this.acted = new Set();
    this.runItTwiceFlag = false;
    this.bombNext = false;
    this.log = [];
    this.turnTimer = null;
    this.turnTimerStartedAt = 0;
    this.turnTimerDuration = 0;
    this.autoDealTimer = null;
    this.dealTimers = [];
    this.endingAfterHand = false;
    this.wentToShowdown = false;
    this.lastWinners = [];
    this.winSummary = '';
    this.ritVotes = null;
    this.ritVoteTimer = null;
  }
  get sb() { return Math.floor(this.settings.bb / 2); }
  get bb() { return this.settings.bb; }
  addLog(text) {
    const t = new Date().toLocaleTimeString();
    this.log.unshift(`[${t}] ${text}`);
    if (this.log.length > 200) this.log.pop();
  }
  activePlayers() { return [...this.players.values()].filter(p => p.seated && !p.away && !p.out); }
  inHandPlayers() { return [...this.players.values()].filter(p => p.inHand); }
  notFolded() { return this.inHandPlayers().filter(p => !p.folded); }
  canAct() { return this.notFolded().filter(p => !p.allIn); }
  livePot() { return this.inHandPlayers().reduce((s, p) => s + p.handContrib, 0); }
  buildPots() {
    const contrib = {};
    for (const p of this.inHandPlayers()) contrib[p.id] = p.handContrib;
    const levels = [...new Set(Object.values(contrib).filter(v => v > 0))].sort((a,b)=>a-b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const eligible = Object.keys(contrib).filter(id => contrib[id] >= level);
      const amount = (level - prev) * eligible.length;
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    this.pots = pots;
  }
}

function clearDealTimers(room) {
  for (const t of room.dealTimers) clearTimeout(t);
  room.dealTimers = [];
}
function scheduleDeal(room, fn, delay) {
  const t = setTimeout(() => {
    room.dealTimers = room.dealTimers.filter(x => x !== t);
    fn();
  }, delay);
  room.dealTimers.push(t);
}

/* ─────────────── SNAPSHOT ─────────────── */
function turnTimerRemaining(room) {
  if (!room.turnTimerDuration) return 0;
  if (!room.turnTimer) return Math.ceil(room.turnTimerDuration / 1000);
  const elapsed = Date.now() - room.turnTimerStartedAt;
  const remaining = Math.max(0, room.turnTimerDuration - elapsed);
  return Math.ceil(remaining / 1000);
}

function roomSnapshot(room, viewerId) {
  const isShowdown = room.phase === 'showdown';
  const isEnded = room.phase === 'ended';
  const winners = new Set(room.lastWinners || []);

  const players = [...room.players.values()].map(p => {
    let handRank = null, preflop = null;
    if (p.hole && p.hole.length === 2) {
      if (room.board.length >= 3 && ['flop','turn','river'].includes(room.phase)) {
        const r = rank7([...p.hole, ...room.board]);
        handRank = r ? r.name : null;
      } else if (room.phase === 'preflop') {
        preflop = preflopLabel(p.hole);
      } else if (isShowdown && p.revealed) {
        const r = rank7([...p.hole, ...room.board]);
        handRank = r ? r.name : null;
      }
    }
    const showHole =
      p.id === viewerId ||
      (isShowdown && p.revealed) ||
      (isEnded && p.revealed);

    return {
      id: p.id, name: p.name, chips: p.chips,
      seated: p.seated, away: p.away, leaveAfterHand: p.leaveAfterHand,
      inHand: p.inHand, folded: p.folded, allIn: p.allIn,
      bet: p.bet, handContrib: p.handContrib,
      hole: showHole ? p.hole : p.hole.map(() => '??'),
      lastAction: p.lastAction,
      isAdmin: p.id === room.adminId,
      isTurn: p.id === room.turnId,
      connected: p.connected,
      buyIns: p.buyIns, pendingBuyin: p.pendingBuyin,
      revealed: !!p.revealed, atShowdown: !!p.atShowdown,
      isWinner: winners.has(p.id),
      handRank, preflop,
      lastWin: p.lastWin || 0
    };
  });

  return {
    code: room.code, adminId: room.adminId,
    settings: {
      bb: room.settings.bb, sb: room.sb,
      minBuyin: room.settings.minBuyin,
      ante: room.settings.ante,
      timer: room.settings.timer,
      maxSeats: room.settings.maxSeats
    },
    phase: room.phase, handNumber: room.handNumber,
    board: room.board, board2: room.board2,
    pot: room.livePot(), currentBet: room.currentBet, minRaise: room.minRaise,
    turnId: room.turnId, dealerId: room.dealerId,
    paused: room.paused,
    runItTwiceArmed: room.runItTwiceFlag,
    bombNext: room.bombNext,
    endingAfterHand: room.endingAfterHand,
    turnTimerRemaining: turnTimerRemaining(room),
    turnTimerDuration: room.settings.timer,
    players, log: room.log, deckHash: room.deckHash,
    wentToShowdown: room.wentToShowdown,
    winners: [...winners],
    winSummary: room.winSummary || '',
    ritVotes: room.ritVotes || {}
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', roomSnapshot(room, p.id));
  }
}
function systemMsg(room, text) {
  room.addLog(text);
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('toast', text);
  }
}

/* ─────────────── TURN TIMER ─────────────── */
function startTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  if (!room.settings.timer || !room.turnId || room.paused) return;
  const ms = room.settings.timer * 1000;
  room.turnTimerStartedAt = Date.now();
  room.turnTimerDuration = ms;
  room.turnTimer = setTimeout(() => {
    const p = room.players.get(room.turnId);
    if (!p) return;
    handleAction(room, p.id, { type: 'fold' });
  }, ms);
}
function pauseTurnTimer(room) {
  if (!room.turnTimer) return;
  clearTimeout(room.turnTimer);
  const elapsed = Date.now() - room.turnTimerStartedAt;
  room.turnTimerDuration = Math.max(0, room.turnTimerDuration - elapsed);
  room.turnTimer = null;
}
function resumeTurnTimer(room) {
  if (!room.turnId) return;
  if (room.turnTimerDuration <= 0) room.turnTimerDuration = room.settings.timer * 1000;
  room.turnTimerStartedAt = Date.now();
  room.turnTimer = setTimeout(() => {
    const p = room.players.get(room.turnId);
    if (!p) return;
    handleAction(room, p.id, { type: 'fold' });
  }, room.turnTimerDuration);
}

/* ─────────────── AUTO DEAL ─────────────── */
function scheduleAutoDeal(room, delay = 3000) {
  clearTimeout(room.autoDealTimer);
  room.autoDealTimer = null;
  if (room.endingAfterHand || room.paused) return;
  const eligible = room.activePlayers().filter(p => p.chips > 0);
  if (eligible.length < 2) return;
  room.autoDealTimer = setTimeout(() => {
    if (room.endingAfterHand || room.paused) return;
    if (room.phase !== 'waiting') return;
    const el = room.activePlayers().filter(p => p.chips > 0);
    if (el.length < 2) return;
    startNewHand(room);
  }, delay);
}

function emitGameEnded(room) {
  clearDealTimers(room);
  room.endingAfterHand = true;
  room.phase = 'ended';
  clearTimeout(room.turnTimer);
  clearTimeout(room.autoDealTimer);
  room.addLog('■ Game ended.');
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('game_ended', roomSnapshot(room, p.id));
  }
}

/* ─────────────── POKER FLOW ─────────────── */
function startNewHand(room) {
  clearTimeout(room.autoDealTimer);
  clearDealTimers(room);
  const seated = room.activePlayers();
  if (seated.length < 2) { systemMsg(room, 'Need at least 2 seated players.'); room.phase = 'waiting'; return; }

  room.handNumber++;
  room.deck = newDeck();
  room.deckHash = deckFingerprint(room.deck);
  room.board = [];
  room.board2 = [];
  room.pots = [];
  room.acted = new Set();
  room.currentBet = 0;
  room.minRaise = room.bb;
  room.wentToShowdown = false;
  room.phase = 'preflop';
  room.runItTwiceFlag = false;
  room.lastWinners = [];
  room.winSummary = '';
  room.ritVotes = null;

  for (const p of room.players.values()) {
    p.hole = []; p.folded = false; p.allIn = false;
    p.bet = 0; p.handContrib = 0; p.lastAction = null;
    p.revealed = false; p.atShowdown = false; p.lastWin = 0;
    p.inHand = p.seated && !p.away && !p.out && p.chips > 0;
  }
  const inHand = room.inHandPlayers();
  if (inHand.length < 2) { systemMsg(room, 'Not enough players with chips.'); room.phase = 'waiting'; return; }

  const order = room.activePlayers();
  const dealerIdx = room.dealerId ? order.findIndex(p => p.id === room.dealerId) : -1;
  room.dealerId = order[(dealerIdx + 1) % order.length].id;

  for (let r = 0; r < 2; r++) for (const p of inHand) p.hole.push(room.deck.pop());

  const hud = inHand.length === 2;
  const dIdx = inHand.findIndex(p => p.id === room.dealerId);
  const sbId = hud ? inHand[dIdx].id : inHand[(dIdx + 1) % inHand.length].id;
  const bbId = hud ? inHand[(dIdx + 1) % inHand.length].id : inHand[(dIdx + 2) % inHand.length].id;

  postBet(room, room.players.get(sbId), room.sb, 'SB');
  postBet(room, room.players.get(bbId), room.bb, 'BB');
  room.currentBet = room.bb;
  room.minRaise = room.bb;

  if (room.bombNext) {
    for (const p of inHand) {
      const amt = Math.min(room.settings.ante, p.chips);
      p.chips -= amt; p.handContrib += amt; p.bet += amt;
    }
    room.bombNext = false;
    room.addLog(`💣 BOMB POT — everyone ante ${room.settings.ante}`);
    for (let i = 0; i < 3; i++) room.board.push(room.deck.pop());
    room.phase = 'flop';
    room.currentBet = 0; room.minRaise = room.bb;
    for (const p of inHand) p.bet = 0;
    room.turnId = inHand[(inHand.findIndex(p=>p.id===room.dealerId) + 1) % inHand.length].id;
  } else {
    room.turnId = inHand[(inHand.findIndex(p=>p.id===bbId) + 1) % inHand.length].id;
  }

  advanceTurnIfNeeded(room, true);
  room.addLog(`▶ Hand #${room.handNumber} — dealer: ${room.players.get(room.dealerId).name} — blinds ${room.sb}/${room.bb}`);
  startTurnTimer(room);
  broadcast(room);
}

function postBet(room, player, amount, label) {
  const amt = Math.min(amount, player.chips);
  player.chips -= amt;
  player.bet += amt;
  player.handContrib += amt;
  if (player.chips === 0) player.allIn = true;
  if (label) player.lastAction = label;
}

function advanceTurnIfNeeded(room, fresh = false) {
  const inHand = room.inHandPlayers();
  if (!inHand.length) { endBettingRound(room); return; }
  const startIdx = room.turnId ? inHand.findIndex(p => p.id === room.turnId) : -1;
  const offset = fresh ? 0 : 1;
  for (let i = 0; i < inHand.length; i++) {
    const p = inHand[(startIdx + i + offset + inHand.length) % inHand.length];
    if (p.folded || p.allIn) continue;
    const needsAction = !room.acted.has(p.id) || p.bet < room.currentBet;
    if (needsAction) { room.turnId = p.id; return; }
  }
  endBettingRound(room);
}

function handleAction(room, playerId, action) {
  const p = room.players.get(playerId);
  if (!p || p.id !== room.turnId) return;
  if (room.paused) return;
  if (!['preflop','flop','turn','river'].includes(room.phase)) return;

  const toCall = room.currentBet - p.bet;
  if (action.type === 'fold') {
    p.folded = true; p.lastAction = 'Fold';
  } else if (action.type === 'check') {
    if (toCall > 0) return;
    p.lastAction = 'Check';
  } else if (action.type === 'call') {
    const amt = Math.min(toCall, p.chips);
    p.chips -= amt; p.bet += amt; p.handContrib += amt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = amt < toCall ? `All-in ${amt}` : `Call ${amt}`;
  } else if (action.type === 'raise') {
    const intAmount = Math.floor(action.amount);
    const target = Math.max(room.currentBet + room.minRaise, intAmount);
    const needed = target - p.bet;
    const amt = Math.min(needed, p.chips);
    p.chips -= amt; p.bet += amt; p.handContrib += amt;
    if (p.chips === 0) p.allIn = true;
    const raiseSize = p.bet - room.currentBet;
    if (raiseSize >= room.minRaise) { room.minRaise = raiseSize; room.acted.clear(); }
    room.currentBet = Math.max(room.currentBet, p.bet);
    p.lastAction = p.allIn ? `All-in ${p.bet}` : `Raise to ${p.bet}`;
  }
  room.acted.add(p.id);

  const remaining = room.notFolded();
  if (remaining.length === 1) {
    awardPotTo(room, remaining[0], 'last player standing');
    return;
  }
  if (room.canAct().length === 0) return runOutBoard(room);

  advanceTurnIfNeeded(room, false);
  startTurnTimer(room);
  broadcast(room);
}

function endBettingRound(room) {
  room.buildPots();
  for (const p of room.inHandPlayers()) p.bet = 0;
  room.currentBet = 0;
  room.minRaise = room.bb;
  room.acted.clear();
  room.turnId = null;
  clearTimeout(room.turnTimer);
  room.turnTimer = null;

  if (room.phase === 'preflop') {
    room.phase = 'dealing';
    broadcast(room);
    const c1 = room.deck.pop(), c2 = room.deck.pop(), c3 = room.deck.pop();
    scheduleDeal(room, () => {
      room.board.push(c1); broadcast(room);
      scheduleDeal(room, () => {
        room.board.push(c2); broadcast(room);
        scheduleDeal(room, () => {
          room.board.push(c3); broadcast(room);
          scheduleDeal(room, () => startPostflopBetting(room, 'flop'), 100);
        }, 500);
      }, 500);
    }, 500);
  } else if (room.phase === 'flop') {
    room.phase = 'dealing';
    broadcast(room);
    const c = room.deck.pop();
    scheduleDeal(room, () => {
      room.board.push(c); broadcast(room);
      scheduleDeal(room, () => startPostflopBetting(room, 'turn'), 100);
    }, 1000);
  } else if (room.phase === 'turn') {
    room.phase = 'dealing';
    broadcast(room);
    const c = room.deck.pop();
    scheduleDeal(room, () => {
      room.board.push(c); broadcast(room);
      scheduleDeal(room, () => startPostflopBetting(room, 'river'), 100);
    }, 1000);
  } else if (room.phase === 'river') {
    if (room.settings.minBuyin > 0 && room.livePot() >= room.settings.minBuyin && room.notFolded().length >= 2) {
      initiateRitVote(room);
    } else {
      showdown(room);
    }
  }
}

function startPostflopBetting(room, nextPhase) {
  room.phase = nextPhase;
  if (room.canAct().length <= 1) return runOutBoard(room);
  const order = room.inHandPlayers().filter(p => !p.folded);
  const dIdx = order.findIndex(p => p.id === room.dealerId);
  room.turnId = order[(dIdx + 1) % order.length].id;
  advanceTurnIfNeeded(room, true);
  if (room.canAct().length <= 1) return runOutBoard(room);
  startTurnTimer(room);
  broadcast(room);
}

function runOutBoard(room) {
  while (room.board.length < 5) room.board.push(room.deck.pop());
  if (room.settings.minBuyin > 0 && room.livePot() >= room.settings.minBuyin && room.notFolded().length >= 2) {
    initiateRitVote(room);
  } else {
    showdown(room);
  }
}

/* ─────────────── RUN IT TWICE VOTING ─────────────── */
function initiateRitVote(room) {
  room.phase = 'rit_vote';
  room.ritVotes = {};
  for (const p of room.notFolded()) room.ritVotes[p.id] = null;
  broadcast(room);
  systemMsg(room, 'Pot is large. Deciding whether to run it twice...');

  clearTimeout(room.ritVoteTimer);
  room.ritVoteTimer = setTimeout(() => {
    if (room.phase !== 'rit_vote') return;
    for (const id in room.ritVotes) if (room.ritVotes[id] === null) room.ritVotes[id] = false;
    resolveRitVote(room);
  }, 15000);
}

function resolveRitVote(room) {
  clearTimeout(room.ritVoteTimer);
  const allYes = Object.values(room.ritVotes).every(v => v === true);
  room.runItTwiceFlag = allYes;
  if (allYes) systemMsg(room, '🔁 All agreed — running it twice.');
  else systemMsg(room, '❌ Run it twice declined.');
  showdown(room);
}

function showdown(room) {
  if (room.runItTwiceFlag && room.notFolded().length >= 2 && !room.board2.length) {
    room.board2 = [];
    while (room.board2.length < 5) room.board2.push(room.deck.pop());
  }

  room.phase = 'showdown';
  room.wentToShowdown = true;
  const alive = room.notFolded();

  for (const p of room.players.values()) p.atShowdown = false;
  for (const p of alive) p.atShowdown = true;

  const results = alive.map(p => ({
    id: p.id, name: p.name, hole: p.hole,
    rank: rank7([...p.hole, ...room.board]),
    rank2: room.board2.length ? rank7([...p.hole, ...room.board2]) : null
  }));

  room.buildPots();
  const pots = room.pots.length ? room.pots : [{ amount: room.livePot(), eligible: alive.map(p => p.id) }];
  const payouts = {};
  const summary = [];

  if (room.board2.length) {
    for (const pot of pots) {
      const elig = results.filter(r => pot.eligible.includes(r.id));
      const half = Math.floor(pot.amount / 2);
      const rest = pot.amount - half;
      const best1 = elig.reduce((a,b)=> cmpRank(a.rank, b.rank) >= 0 ? a : b);
      const winners1 = elig.filter(r => cmpRank(r.rank, best1.rank) === 0);
      const share1 = Math.floor(half / winners1.length);
      winners1.forEach(w => payouts[w.id] = (payouts[w.id]||0) + share1);
      const best2 = elig.reduce((a,b)=> cmpRank(a.rank2, b.rank2) >= 0 ? a : b);
      const winners2 = elig.filter(r => cmpRank(r.rank2, best2.rank2) === 0);
      const share2 = Math.floor(rest / winners2.length);
      winners2.forEach(w => payouts[w.id] = (payouts[w.id]||0) + share2);
    }
  } else {
    for (const pot of pots) {
      const elig = results.filter(r => pot.eligible.includes(r.id));
      if (!elig.length) continue;
      const best = elig.reduce((a,b)=> cmpRank(a.rank, b.rank) >= 0 ? a : b);
      const winners = elig.filter(r => cmpRank(r.rank, best.rank) === 0);
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach(w => payouts[w.id] = (payouts[w.id]||0) + share);
    }
  }

  for (const [id, amt] of Object.entries(payouts)) {
    const p = room.players.get(id);
    if (p) p.chips += amt;
  }
  let distributed = Object.values(payouts).reduce((a,b)=>a+b,0);
  let leftover = room.livePot() - distributed;
  if (leftover > 0 && results.length) {
    const best = results.reduce((a,b)=> cmpRank(a.rank, b.rank) >= 0 ? a : b);
    room.players.get(best.id).chips += leftover;
    payouts[best.id] = (payouts[best.id] || 0) + leftover;
  }

  const winnerIds = Object.keys(payouts).filter(id => payouts[id] > 0);
  room.lastWinners = winnerIds;
  for (const p of room.players.values()) {
    p.revealed = winnerIds.includes(p.id);
    const payout = payouts[p.id] || 0;
    p.lastWin = payout > 0 ? (payout - p.handContrib) : 0;
  }

  const winNames = winnerIds.map(id => room.players.get(id).name);
  if (winNames.length === 1) {
    const w = room.players.get(winnerIds[0]);
    room.winSummary = `${w.name} wins +${w.lastWin}`;
  } else if (winNames.length > 1) {
    room.winSummary = `${winNames.join(', ')} split the pot`;
  }

  for (const r of results) {
    const win = payouts[r.id] || 0;
    summary.push(`${r.name}: ${r.hole.join(' ')} → ${r.rank.name}${win ? ` — WINS ${win}` : ''}`);
  }
  room.addLog(`🏆 Showdown hand #${room.handNumber}: ` + summary.join(' | '));

  for (const p of room.inHandPlayers()) { p.inHand = false; p.bet = 0; }
  room.turnId = null;
  clearTimeout(room.turnTimer);

  for (const p of [...room.players.values()]) {
    if (p.leaveAfterHand) {
      p.seated = false; p.leaveAfterHand = false;
      systemMsg(room, `${p.name} left the table with ${p.chips} chips.`);
    }
  }
  for (const p of room.players.values()) {
    if (p.seated && p.chips === 0) systemMsg(room, `${p.name} is out of chips — rebuy to continue.`);
  }

  broadcast(room);

  clearTimeout(room.autoDealTimer);
  room.autoDealTimer = setTimeout(() => {
    room.phase = 'waiting';
    if (room.endingAfterHand) { emitGameEnded(room); return; }
    for (const p of room.players.values()) p.revealed = false;
    broadcast(room);
    scheduleAutoDeal(room, 500);
  }, 6000);
}

function awardPotTo(room, winner, reason) {
  room.buildPots();
  const total = room.livePot();
  winner.chips += total;
  room.addLog(`💵 ${winner.name} wins ${total} (${reason}).`);

  for (const p of room.players.values()) p.atShowdown = false;
  winner.atShowdown = true;
  room.lastWinners = [winner.id];
  for (const p of room.players.values()) {
    p.revealed = (p.id === winner.id);
    p.lastWin = (p.id === winner.id) ? (total - p.handContrib) : 0;
  }
  room.winSummary = `${winner.name} wins +${winner.lastWin}`;

  for (const p of room.inHandPlayers()) { p.inHand = false; p.bet = 0; }
  room.turnId = null;
  clearTimeout(room.turnTimer);
  room.phase = 'showdown';

  for (const p of [...room.players.values()]) {
    if (p.leaveAfterHand) {
      p.seated = false; p.leaveAfterHand = false;
      systemMsg(room, `${p.name} left the table with ${p.chips} chips.`);
    }
  }

  broadcast(room);

  clearTimeout(room.autoDealTimer);
  room.autoDealTimer = setTimeout(() => {
    room.phase = 'waiting';
    if (room.endingAfterHand) { emitGameEnded(room); return; }
    for (const p of room.players.values()) p.revealed = false;
    broadcast(room);
    scheduleAutoDeal(room, 500);
  }, 6000);
}

/* ─────────────── SOCKET.IO ─────────────── */
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
  return rooms.has(c) ? makeCode() : c;
}

function makePlayer(id, socketId, name, clientId) {
  return {
    id, socketId, name, clientId,
    chips: 0, seated: true, away: false, leaveAfterHand: false,
    inHand: false, folded: false, allIn: false, bet: 0, handContrib: 0,
    hole: [], lastAction: null, buyIns: [], pendingBuyin: null, out: false,
    connected: true, revealed: false, atShowdown: false, lastWin: 0
  };
}

function requestBuyin(room, player, amount) {
  amount = Math.max(1, Math.floor(amount));

  // ★ STRICT LOCK: Prevent duplicate pending requests
  if (player.pendingBuyin != null) {
    return { ok: false, err: 'You already have a pending buy-in request.' };
  }

  const isFirst = player.buyIns.length === 0;
  if (isFirst && room.settings.minBuyin > 0 && amount < room.settings.minBuyin) {
    return { ok: false, err: `Min initial buy-in is ${room.settings.minBuyin}.` };
  }

  player.pendingBuyin = amount;
  if (player.id === room.adminId) {
    player.chips += amount;
    player.buyIns.push(amount);
    player.pendingBuyin = null;
    room.addLog(`${player.name} bought in for ${amount}.`);
  } else {
    room.addLog(`${player.name} requested buy-in of ${amount}.`);
    const admin = room.players.get(room.adminId);
    if (admin && admin.socketId) {
      io.to(admin.socketId).emit('buyin_request_popup', {
        playerId: player.id, playerName: player.name, amount, isFirst
      });
    }
  }
  return { ok: true };
}

io.on('connection', socket => {
  let myRoom = null;
  let myId = null;

  socket.on('peek_room', ({ code }, cb) => {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) return cb({ ok: false, err: 'Table not found.' });
    cb({
      ok: true, bb: room.settings.bb, sb: room.sb,
      minBuyin: room.settings.minBuyin, maxSeats: room.settings.maxSeats,
      players: room.players.size
    });
  });

  socket.on('create_room', ({ name, clientId }, cb) => {
    name = (name || '').trim().slice(0, 14) || 'Host';
    const code = makeCode();
    const room = new Room(code);
    rooms.set(code, room);
    myId = nextId();
    const p = makePlayer(myId, socket.id, name, clientId);
    room.players.set(myId, p);
    room.adminId = myId;
    room.addLog(`${name} created the table.`);
    myRoom = room;
    socket.join(code);
    cb({ ok: true, code, id: myId });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name, clientId }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, err: 'No table with that code.' });

    if (clientId) {
      const existing = [...room.players.values()].find(p => p.clientId === clientId);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        myId = existing.id;
        myRoom = room;
        socket.join(code);
        cb({ ok: true, code, id: myId, resumed: true });
        broadcast(room);
        return;
      }
    }
    if (room.players.size >= room.settings.maxSeats)
      return cb({ ok: false, err: 'Table is full.' });
    name = (name || '').trim().slice(0, 14);
    if (!name) return cb({ ok: false, err: 'Enter a name.' });

    const byName = [...room.players.values()].find(p => p.name === name && !p.connected);
    if (byName) {
      byName.socketId = socket.id;
      byName.connected = true;
      if (clientId) byName.clientId = clientId;
      myId = byName.id;
      myRoom = room;
      socket.join(code);
      cb({ ok: true, code, id: myId, resumed: true });
      broadcast(room);
      return;
    }

    myId = nextId();
    const p = makePlayer(myId, socket.id, name, clientId);
    room.players.set(myId, p);
    room.addLog(`${name} joined the table.`);
    myRoom = room;
    socket.join(code);

    // Only auto-request if there is a set minimum. The client will not prompt them.
    if (room.settings.minBuyin > 0 && p.buyIns.length === 0 && !p.pendingBuyin) {
      requestBuyin(room, p, room.settings.minBuyin);
    }

    cb({ ok: true, code, id: myId });
    broadcast(room);
  });

  socket.on('request_buyin', ({ amount }) => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    const res = requestBuyin(myRoom, p, amount);
    if (!res.ok) return socket.emit('toast', res.err);
    if (p.chips === 0 && p.away) p.away = false;
    broadcast(myRoom);
  });

  socket.on('admin_resolve_buyin', ({ playerId, approve }) => {
    if (!myRoom || myId !== myRoom.adminId) return;
    const p = myRoom.players.get(playerId);
    if (!p || p.pendingBuyin == null) return;
    if (approve) {
      p.chips += p.pendingBuyin;
      p.buyIns.push(p.pendingBuyin);
      myRoom.addLog(`✅ Admin approved ${p.name}'s buy-in of ${p.pendingBuyin}.`);
    } else {
      myRoom.addLog(`❌ Admin declined ${p.name}'s buy-in.`);
    }
    p.pendingBuyin = null;
    broadcast(myRoom);
  });

  socket.on('admin_settings', (patch) => {
    if (!myRoom || myId !== myRoom.adminId) return;
    const s = myRoom.settings;
    if (patch.bb >= 2) s.bb = Math.floor(patch.bb);
    if (patch.minBuyin >= 0) s.minBuyin = Math.floor(patch.minBuyin);
    if (patch.ante >= 0) s.ante = Math.floor(patch.ante);
    if (patch.timer >= 0) s.timer = Math.floor(patch.timer);
    if (patch.maxSeats >= 2 && patch.maxSeats <= 10) s.maxSeats = Math.floor(patch.maxSeats);
    myRoom.addLog(`⚙ Settings: blinds ${myRoom.sb}/${myRoom.bb}, min buy-in ${s.minBuyin || '—'}, ante ${s.ante}, timer ${s.timer}s.`);
    broadcast(myRoom);
  });

  socket.on('admin_start_game', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    if (myRoom.handNumber > 0) return;
    if (myRoom.phase !== 'waiting') return;
    if (myRoom.paused) return socket.emit('toast', 'Table is paused.');
    startNewHand(myRoom);
  });

  socket.on('admin_bomb', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    myRoom.bombNext = true;
    myRoom.addLog('💣 Bomb pot armed for next hand.');
    systemMsg(myRoom, '💣 Bomb pot armed for next hand.');
    broadcast(myRoom);
  });

  socket.on('admin_rit', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    myRoom.runItTwiceFlag = !myRoom.runItTwiceFlag;
    systemMsg(myRoom, myRoom.runItTwiceFlag ? '🔁 Run it twice: ON' : 'Run it twice: OFF');
    broadcast(myRoom);
  });

  socket.on('admin_pause', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    myRoom.paused = !myRoom.paused;
    if (myRoom.paused) {
      pauseTurnTimer(myRoom);
      clearTimeout(myRoom.autoDealTimer);
      myRoom.autoDealTimer = null;
      systemMsg(myRoom, '⏸ Game paused.');
    } else {
      resumeTurnTimer(myRoom);
      systemMsg(myRoom, '▶ Game resumed.');
      if (myRoom.phase === 'waiting' && !myRoom.endingAfterHand) scheduleAutoDeal(myRoom);
    }
    broadcast(myRoom);
  });

  socket.on('admin_end', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    if (myRoom.phase === 'waiting' || myRoom.phase === 'ended' || myRoom.handNumber === 0) {
      emitGameEnded(myRoom);
    } else {
      myRoom.endingAfterHand = true;
      myRoom.addLog('■ Game will end after this hand.');
      systemMsg(myRoom, '■ Last hand — game will end after this hand.');
      broadcast(myRoom);
    }
  });

  socket.on('player_action', (action) => {
    if (!myRoom || !myId) return;
    handleAction(myRoom, myId, action);
  });

  socket.on('vote_rit', ({ agree }) => {
    if (!myRoom || !myId) return;
    if (myRoom.phase !== 'rit_vote') return;
    if (!(myId in myRoom.ritVotes)) return;
    myRoom.ritVotes[myId] = agree;
    const allVoted = Object.values(myRoom.ritVotes).every(v => v !== null);
    if (allVoted) resolveRitVote(myRoom);
    else broadcast(myRoom);
  });

  socket.on('reveal_hand', () => {
    if (!myRoom || !myId) return;
    if (myRoom.phase !== 'showdown') return;
    const p = myRoom.players.get(myId);
    if (!p || p.revealed || !p.atShowdown) return;
    p.revealed = true;
    myRoom.addLog(`${p.name} showed their hand.`);
    broadcast(myRoom);
  });

  socket.on('away_toggle', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    p.away = !p.away;
    myRoom.addLog(`${p.name} is ${p.away ? 'away (sits out after current hand)' : 'back'}.`);
    broadcast(myRoom);
  });

  socket.on('spectate', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    p.away = true;
    myRoom.addLog(`${p.name} is spectating.`);
    broadcast(myRoom);
  });

  socket.on('leave_after_hand', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    if (!p.inHand) {
      p.seated = false;
      myRoom.addLog(`${p.name} left the table.`);
    } else {
      p.leaveAfterHand = true;
      myRoom.addLog(`${p.name} will leave after the current hand.`);
    }
    broadcast(myRoom);
  });

  socket.on('disconnect', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    myRoom.addLog(`${p.name} disconnected.`);
    broadcast(myRoom);
  });
});

server.listen(PORT, () => console.log(`♠ Home Poker running on http://localhost:${PORT}`));