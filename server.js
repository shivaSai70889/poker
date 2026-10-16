const express = require('express');
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
const rooms = new Map(); // code -> Room

/* ─────────────── TRUE RANDOM SHUFFLE ───────────────
   Uses crypto.randomInt() which pulls from the OS CSPRNG
   (/dev/urandom on Linux, BCryptGenRandom on Windows).
   Fisher–Yates is the unbiased algorithm; the *entropy*
   comes from the OS, not a seeded PRNG.                */
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
const SYM = { s:'♠', h:'♥', d:'♦', c:'♣' };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return secureShuffle(d);
}
function deckFingerprint(deck) {
  // Optional "provably fair" check: publish this before the hand.
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

/* ─────────────── ROOM / GAME STATE ─────────────── */
let idCounter = 0;
const nextId = () => 'p' + (++idCounter) + Date.now().toString(36);

class Room {
  constructor(code) {
    this.code = code;
    this.adminId = null;
    this.players = new Map();       // id -> player
    this.settings = { sb: 1, bb: 2, minBuyin: 100, ante: 0, timer: 0, maxSeats: 10 };
    this.paused = false;
    this.phase = 'waiting';          // waiting | preflop | flop | turn | river | showdown
    this.handNumber = 0;
    this.deck = [];
    this.deckHash = '';
    this.board = [];
    this.board2 = [];
    this.pots = [];                  // side pots
    this.currentBet = 0;
    this.minRaise = 0;
    this.turnId = null;
    this.dealerId = null;
    this.acted = new Set();
    this.runItTwiceFlag = false;
    this.bombNext = false;
    this.log = [];
    this.turnTimer = null;
    this.wentToShowdown = false;
  }
  addLog(text) {
    const t = new Date().toLocaleTimeString();
    this.log.unshift(`[${t}] ${text}`);
    if (this.log.length > 200) this.log.pop();
  }
  activePlayers() {
    return [...this.players.values()].filter(p => p.seated && !p.away && !p.out);
  }
  inHandPlayers() { return [...this.players.values()].filter(p => p.inHand); }
  notFolded() { return this.inHandPlayers().filter(p => !p.folded); }
  canAct() { return this.notFolded().filter(p => !p.allIn); }
  totalPot() { return this.pots.reduce((s, p) => s + p.amount, 0); }
  // The "contribution" here is per-hand chip contributions from each player
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

/* ─────────────── SOCKET HANDLERS ─────────────── */
function roomSnapshot(room, viewerId) {
  const players = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    chips: p.chips,
    seated: p.seated,
    away: p.away,
    leaveAfterHand: p.leaveAfterHand,
    inHand: p.inHand,
    folded: p.folded,
    allIn: p.allIn,
    bet: p.bet,
    handContrib: p.handContrib,
    hole: (p.id === viewerId || room.phase === 'showdown') ? p.hole : p.hole.map(() => '??'),
    lastAction: p.lastAction,
    isAdmin: p.id === room.adminId,
    isTurn: p.id === room.turnId,
    connected: p.connected,
    buyIns: p.buyIns,
    pendingBuyin: p.pendingBuyin
  }));
  return {
    code: room.code,
    adminId: room.adminId,
    settings: room.settings,
    phase: room.phase,
    handNumber: room.handNumber,
    board: room.board,
    board2: room.board2,
    pots: room.pots.map(p => ({ amount: p.amount })),
    pot: room.totalPot(),
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    turnId: room.turnId,
    dealerId: room.dealerId,
    paused: room.paused,
    runItTwiceArmed: room.runItTwiceFlag,
    bombNext: room.bombNext,
    players,
    log: room.log,
    deckHash: room.deckHash,
    wentToShowdown: room.wentToShowdown
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

/* ─────────────── CORE POKER FLOW ─────────────── */
function startNewHand(room) {
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
  room.minRaise = room.settings.bb;
  room.wentToShowdown = false;
  room.phase = 'preflop';
  room.runItTwiceFlag = false;

  for (const p of room.players.values()) {
    p.hole = []; p.folded = false; p.allIn = false;
    p.bet = 0; p.handContrib = 0; p.lastAction = null;
    p.inHand = p.seated && !p.away && !p.out && p.chips > 0;
  }
  const inHand = room.inHandPlayers();
  if (inHand.length < 2) { systemMsg(room, 'Not enough players with chips.'); room.phase = 'waiting'; return; }

  // Rotate dealer
  const order = room.activePlayers();
  const dealerIdx = room.dealerId ? order.findIndex(p => p.id === room.dealerId) : -1;
  room.dealerId = order[(dealerIdx + 1) % order.length].id;

  // Deal hole cards
  for (let r = 0; r < 2; r++) for (const p of inHand) p.hole.push(room.deck.pop());

  // Blinds (heads-up special rule)
  const hud = inHand.length === 2;
  const dIdx = inHand.findIndex(p => p.id === room.dealerId);
  const sbId = hud ? inHand[dIdx].id : inHand[(dIdx + 1) % inHand.length].id;
  const bbId = hud ? inHand[(dIdx + 1) % inHand.length].id : inHand[(dIdx + 2) % inHand.length].id;

  postBet(room, room.players.get(sbId), room.settings.sb, 'SB');
  postBet(room, room.players.get(bbId), room.settings.bb, 'BB');
  room.currentBet = room.settings.bb;
  room.minRaise = room.settings.bb;

  // Bomb pot ante
  if (room.bombNext) {
    for (const p of inHand) {
      const amt = Math.min(room.settings.ante, p.chips);
      p.chips -= amt; p.handContrib += amt; p.bet += amt;
    }
    room.bombNext = false;
    room.addLog(`💣 BOMB POT — everyone ante ${room.settings.ante}`);
    // Deal flop immediately, skip preflop betting
    for (let i = 0; i < 3; i++) room.board.push(room.deck.pop());
    room.phase = 'flop';
    room.currentBet = 0; room.minRaise = room.settings.bb;
    for (const p of inHand) p.bet = 0;
    room.turnId = inHand[(inHand.findIndex(p=>p.id===room.dealerId) + 1) % inHand.length].id;
  } else {
    room.turnId = inHand[(inHand.findIndex(p=>p.id===bbId) + 1) % inHand.length].id;
  }

  // Ensure turnId is on a player who can act
  advanceTurnIfNeeded(room, true);

  room.addLog(`▶ Hand #${room.handNumber} — dealer: ${room.players.get(room.dealerId).name} — blinds ${room.settings.sb}/${room.settings.bb}`);
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

function startTurnTimer(room) {
  clearTimeout(room.turnTimer);
  if (!room.settings.timer || !room.turnId) return;
  room.turnTimer = setTimeout(() => {
    const p = room.players.get(room.turnId);
    if (!p) return;
    const toCall = room.currentBet - p.bet;
    if (toCall <= 0) handleAction(room, p.id, { type: 'check' });
    else handleAction(room, p.id, { type: 'fold' });
  }, room.settings.timer * 1000);
}

function advanceTurnIfNeeded(room, fresh = false) {
  const canAct = room.canAct();
  if (canAct.length === 0) { endBettingRound(room); return; }
  if (canAct.length === 1 && !fresh) {
    // Everyone else all-in or folded
    const stillToAct = canAct[0];
    const others = room.notFolded().filter(p => p.id !== stillToAct.id);
    if (others.every(p => p.allIn || p.bet >= room.currentBet) && stillToAct.bet >= room.currentBet) {
      endBettingRound(room); return;
    }
  }
  // Find next player in seat order from current turnId
  const inHand = room.inHandPlayers();
  const startIdx = room.turnId ? inHand.findIndex(p => p.id === room.turnId) : -1;
  for (let i = 1; i <= inHand.length; i++) {
    const p = inHand[(startIdx + i + inHand.length) % inHand.length];
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
    if (toCall > 0) return; // illegal
    p.lastAction = 'Check';
  } else if (action.type === 'call') {
    const amt = Math.min(toCall, p.chips);
    p.chips -= amt; p.bet += amt; p.handContrib += amt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = amt < toCall ? `All-in ${amt}` : `Call ${amt}`;
  } else if (action.type === 'raise') {
    const target = Math.max(room.currentBet + room.minRaise, Math.floor(action.amount));
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

  // Check if only one player remains
  const remaining = room.notFolded();
  if (remaining.length === 1) {
    awardPotTo(room, remaining[0], 'last player standing');
    return;
  }

  // If everyone remaining is all-in, run out the board
  if (room.canAct().length === 0) {
    return runOutBoard(room);
  }

  advanceTurnIfNeeded(room);
  startTurnTimer(room);
  broadcast(room);
}

function endBettingRound(room) {
  // Merge bets into pot
  room.buildPots();
  for (const p of room.inHandPlayers()) p.bet = 0;
  room.currentBet = 0;
  room.minRaise = room.settings.bb;
  room.acted.clear();

  if (room.phase === 'preflop') {
    for (let i = 0; i < 3; i++) room.board.push(room.deck.pop());
    room.phase = 'flop';
  } else if (room.phase === 'flop') {
    room.board.push(room.deck.pop());
    room.phase = 'turn';
  } else if (room.phase === 'turn') {
    room.board.push(room.deck.pop());
    room.phase = 'river';
  } else if (room.phase === 'river') {
    return showdown(room);
  }

  // Post-flop: first to act is first non-folded player after dealer
  const inHand = room.inHandPlayers().filter(p => !p.folded && !p.allIn);
  if (inHand.length === 0) return runOutBoard(room);
  const order = room.inHandPlayers().filter(p => !p.folded);
  const dIdx = order.findIndex(p => p.id === room.dealerId);
  room.turnId = order[(dIdx + 1) % order.length].id;

  // If only one player can act, skip
  if (room.canAct().length <= 1) {
    // Check if a single player faces no bet — they auto-check; run it out
    const actor = room.canAct()[0];
    if (actor) actor.lastAction = 'Check';
    return endBettingRound(room);
  }
  startTurnTimer(room);
  broadcast(room);
}

function runOutBoard(room) {
  // Everyone all-in: deal remaining community cards, then showdown.
  // Support Run-It-Twice.
  while (room.board.length < 5) room.board.push(room.deck.pop());

  if (room.runItTwiceFlag && room.notFolded().length >= 2) {
    room.board2 = [];
    while (room.board2.length < 5) room.board2.push(room.deck.pop());
    systemMsg(room, '🔁 Running it twice.');
  }
  showdown(room);
}

function showdown(room) {
  room.phase = 'showdown';
  room.wentToShowdown = true;
  const alive = room.notFolded();

  const results = alive.map(p => ({
    id: p.id,
    name: p.name,
    hole: p.hole,
    rank: rank7([...p.hole, ...room.board]),
    rank2: room.board2.length ? rank7([...p.hole, ...room.board2]) : null
  }));

  // Build side pots
  room.buildPots();
  const pots = room.pots.length ? room.pots : [{ amount: room.totalPot(), eligible: alive.map(p => p.id) }];

  const payouts = {};
  const summary = [];

  if (room.board2.length) {
    // Run it twice: split each pot 50/50, odd chip to first board
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

  // Apply payouts
  for (const [id, amt] of Object.entries(payouts)) {
    const p = room.players.get(id);
    if (p) p.chips += amt;
  }
  // Any leftover odd chips from rounding: give to best hand
  let distributed = Object.values(payouts).reduce((a,b)=>a+b,0);
  let leftover = room.totalPot() - distributed;
  if (leftover > 0 && results.length) {
    const best = results.reduce((a,b)=> cmpRank(a.rank, b.rank) >= 0 ? a : b);
    room.players.get(best.id).chips += leftover;
  }

  // Log
  for (const r of results) {
    const win = payouts[r.id] || 0;
    summary.push(`${r.name}: ${r.hole.join(' ')} → ${r.rank.name}${win ? ` — WINS ${win}` : ''}`);
  }
  room.addLog(`🏆 Showdown hand #${room.handNumber}: ` + summary.join(' | '));

  // Cleanup
  for (const p of room.inHandPlayers()) { p.inHand = false; p.bet = 0; }
  room.pots = [];
  room.turnId = null;

  // Handle leaveAfterHand
  for (const p of [...room.players.values()]) {
    if (p.leaveAfterHand) {
      p.seated = false;
      p.leaveAfterHand = false;
      systemMsg(room, `${p.name} left the table with ${p.chips} chips.`);
    }
  }

  // Players who ran out of chips
  for (const p of room.players.values()) {
    if (p.seated && p.chips === 0) systemMsg(room, `${p.name} is out of chips — rebuy to continue.`);
  }

  room.phase = 'waiting';
  broadcast(room);
}

function awardPotTo(room, winner, reason) {
  room.buildPots();
  const total = room.totalPot();
  winner.chips += total;
  room.addLog(`💵 ${winner.name} wins ${total} (${reason}).`);
  for (const p of room.inHandPlayers()) { p.inHand = false; p.bet = 0; }
  room.pots = [];
  room.turnId = null;
  room.phase = 'waiting';

  for (const p of [...room.players.values()]) {
    if (p.leaveAfterHand) {
      p.seated = false; p.leaveAfterHand = false;
      systemMsg(room, `${p.name} left the table with ${p.chips} chips.`);
    }
  }
  broadcast(room);
}

/* ─────────────── SOCKET.IO ─────────────── */
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
  return rooms.has(c) ? makeCode() : c;
}

io.on('connection', socket => {
  let myRoom = null;
  let myId = null;

  socket.on('create_room', ({ name }, cb) => {
    name = (name || '').trim().slice(0, 14) || 'Host';
    const code = makeCode();
    const room = new Room(code);
    rooms.set(code, room);
    myId = nextId();
    const p = {
      id: myId, socketId: socket.id, name,
      chips: 0, seated: true, away: false, leaveAfterHand: false,
      inHand: false, folded: false, allIn: false, bet: 0, handContrib: 0,
      hole: [], lastAction: null, buyIns: [], pendingBuyin: null, out: false
    };
    room.players.set(myId, p);
    room.adminId = myId;
    room.addLog(`${name} created the table.`);
    myRoom = room;
    socket.join(code);
    cb({ ok: true, code, id: myId });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, err: 'No table with that code.' });
    if (room.players.size >= room.settings.maxSeats)
      return cb({ ok: false, err: 'Table is full.' });
    name = (name || '').trim().slice(0, 14);
    if (!name) return cb({ ok: false, err: 'Enter a name.' });

    // allow re-join by name if disconnected
    let existing = [...room.players.values()].find(p => p.name === name && !p.connected);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      myId = existing.id;
      myRoom = room;
      socket.join(code);
      cb({ ok: true, code, id: myId, reconnect: true });
      broadcast(room);
      return;
    }

    myId = nextId();
    const p = {
      id: myId, socketId: socket.id, name,
      chips: 0, seated: true, away: false, leaveAfterHand: false,
      inHand: false, folded: false, allIn: false, bet: 0, handContrib: 0,
      hole: [], lastAction: null, buyIns: [], pendingBuyin: null, out: false
    };
    room.players.set(myId, p);
    room.addLog(`${name} joined the table.`);
    myRoom = room;
    socket.join(code);
    cb({ ok: true, code, id: myId });
    broadcast(room);
  });

  socket.on('request_buyin', ({ amount }) => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    amount = Math.max(1, Math.floor(amount));
    const isFirst = p.buyIns.length === 0;
    if (isFirst && amount < myRoom.settings.minBuyin)
      return socket.emit('toast', `Min initial buy-in is ${myRoom.settings.minBuyin}.`);
    p.pendingBuyin = amount;
    if (p.id === myRoom.adminId) {
      // Admin auto-approves own buy-in
      p.chips += amount; p.buyIns.push(amount); p.pendingBuyin = null;
      myRoom.addLog(`${p.name} bought in for ${amount}.`);
    } else {
      myRoom.addLog(`${p.name} requested buy-in of ${amount}.`);
      systemMsg(myRoom, `${p.name} requested buy-in of ${amount}.`);
    }
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
    if (patch.sb > 0) s.sb = Math.floor(patch.sb);
    if (patch.bb >= s.sb) s.bb = Math.floor(patch.bb);
    if (patch.minBuyin > 0) s.minBuyin = Math.floor(patch.minBuyin);
    if (patch.ante >= 0) s.ante = Math.floor(patch.ante);
    if (patch.timer >= 0) s.timer = Math.floor(patch.timer);
    if (patch.maxSeats >= 2 && patch.maxSeats <= 10) s.maxSeats = Math.floor(patch.maxSeats);
    myRoom.addLog(`⚙ Settings: blinds ${s.sb}/${s.bb}, min buy-in ${s.minBuyin}, ante ${s.ante}, timer ${s.timer}s.`);
    broadcast(myRoom);
  });

  socket.on('admin_next_hand', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    if (myRoom.phase !== 'waiting') return socket.emit('toast', 'Hand in progress.');
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
    systemMsg(myRoom, myRoom.paused ? '⏸ Game paused.' : '▶ Game resumed.');
    broadcast(myRoom);
  });

  socket.on('admin_end', () => {
    if (!myRoom || myId !== myRoom.adminId) return;
    myRoom.addLog('■ Game ended by admin.');
    for (const p of myRoom.players.values()) {
      if (p.socketId) io.to(p.socketId).emit('game_ended', roomSnapshot(myRoom, p.id));
    }
  });

  socket.on('player_action', (action) => {
    if (!myRoom || !myId) return;
    handleAction(myRoom, myId, action);
  });

  socket.on('away_toggle', () => {
    if (!myRoom || !myId) return;
    const p = myRoom.players.get(myId);
    if (!p) return;
    p.away = !p.away;
    myRoom.addLog(`${p.name} is ${p.away ? 'away (sits out after current hand)' : 'back'}.`);
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