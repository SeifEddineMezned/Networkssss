// Transport-agnostic game session logic, shared by the TCP and the UDP server.
// Accounts, lobby, rooms (wrapping PvP's NetplayServer), scores, results, disconnects.
//
// The transport gives us:
//   send(peer, msg, reliable)  -> deliver {t,d} to that peer (reliable=false only for state streams)
// and calls:
//   session.addPeer(peer)                 when a client completed the transport handshake
//   session.handle(peer, msg, reliable)   for every validated client message
//   session.drop(peer, reason)            when the transport detects the peer is gone
//   session.tick()                        every 250 ms (scoreboards, heartbeat timeouts)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { C, NAMES, validateClient } = require('./protocol');
const netplayserver = require('../../client/js/netplay-server.js');

const MAX_PLAYERS = 4;

class Accounts {
  constructor(file) {
    this.file = file;
    this.users = {};
    try { this.users = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { this.users = {}; }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.users, null, 1));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('[accounts] save failed', e.message); }
  }
  hash(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }
  register(user, pass) {
    const key = user.toLowerCase();
    if (this.users[key]) return 'Username already taken';
    const salt = crypto.randomBytes(16).toString('hex');
    this.users[key] = { user, salt, hash: this.hash(pass, salt), created: new Date().toISOString(), wins: 0, games: 0 };
    this.save();
    return null;
  }
  check(user, pass) {
    const u = this.users[user.toLowerCase()];
    if (!u) return 'Unknown user (register first)';
    const h = Buffer.from(this.hash(pass, u.salt), 'hex');
    if (!crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return 'Wrong password';
    return null;
  }
  get(user) { return this.users[user.toLowerCase()]; }
}

class Session {
  constructor(opts) {
    this.transport = opts.transport;            // 'TCP' | 'UDP'
    this.sendRaw = opts.send;
    this.metrics = opts.metrics || null;
    this.heartbeatTimeout = opts.heartbeatTimeout || 6000;
    this.verbose = !!opts.verbose;
    this.accounts = new Accounts(opts.accountsFile || path.join(__dirname, '..', 'data', 'accounts.json'));
    this.peers = new Map();       // peer.id -> peer
    this.byUser = new Map();      // lowercased username -> peer
    this.rooms = new Map();       // roomId -> room meta
    this._reliable = true;        // channel used by NetplayServer.sendToPlayer callbacks
    this.lastScoreboard = 0;

    this.np = new netplayserver.NetplayServer({
      logLevel: 0,
      netcodes: netplayserver,
      sendToPlayer: (peer, type, data) => this.send(peer, type, data, this._reliable),
    });
  }

  log(...a) { console.log(new Date().toISOString().substr(11, 12), `[${this.transport}]`, ...a); }

  send(peer, t, d, reliable = true) {
    if (!peer || peer.gone) return;
    try { this.sendRaw(peer, { t, d }, reliable); } catch (e) { this.log('send error', e.message); }
  }

  // ---------------------------------------------------------------- peers
  addPeer(peer) {
    peer.user = null;
    peer.roomId = null;
    peer.lastSeen = Date.now();
    peer.rtt = null;
    peer.connectedAt = Date.now();
    this.peers.set(peer.id, peer);
    this.log(`connect   ${peer.id} from ${peer.addr}`);
  }

  touch(peer) { peer.lastSeen = Date.now(); }

  handle(peer, rawMsg, reliable = true) {
    try {
      if (!this.peers.has(peer.id)) return;
      this.touch(peer);
      const msg = validateClient(rawMsg);
      if (!msg) { if (this.metrics) this.metrics.inc('invalid'); return; }
      this._dispatch(peer, msg, reliable);
    } catch (e) {
      this.log('handler error (ignored):', e && e.stack || e);
    }
  }

  _dispatch(peer, msg, reliable) {
    const d = msg.d;
    switch (msg.t) {
      case C.HELLO: return;
      case C.PING: return this.send(peer, C.PONG, { ts: d.ts }, false);
      case C.PONG: { const r = Date.now() - d.ts; if (r >= 0 && r < 60000) peer.rtt = r; return; }
      case C.REGISTER: return this.register(peer, d);
      case C.LOGIN: return this.login(peer, d);
      case C.BYE: return this.drop(peer, 'bye');
    }
    if (!peer.user) return this.send(peer, C.ERROR, { code: 'notLoggedIn', msg: 'Login first' });
    switch (msg.t) {
      case C.LOGOUT: this.leaveRoom(peer, 'left'); this.byUser.delete(peer.user.toLowerCase()); peer.user = null; return;
      case C.ROOM_LIST_REQ: return this.send(peer, C.ROOM_LIST, this.roomList());
      case C.CREATE_ROOM: return this.createRoom(peer, d.name);
      case C.JOINROOM: return this.joinRoom(peer, d[0], d[2]);
      case C.LEAVEROOM: return this.leaveRoom(peer, 'left');
      case C.SETCONFIRM: return this.setConfirm(peer, d);
      case C.UPDATESETUP: if (this.isHost(peer)) this.np.updateSetup(peer.id, d); return;
      case C.FREEZEROOM: return this.startGame(peer, d);
      case C.BROADCAST: return this.relayState(peer, d, reliable);
      case C.SENDEVENT: return this.relayEvent(peer, d);
      case C.SCORE_EVENT: return this.scoreEvent(peer, d);
      case C.GAME_END_REQ: {
        const room = this.rooms.get(peer.roomId);
        if (room && room.status === 'playing' && this.isHost(peer)) this.endGame(room, 'gameOver');
        return;
      }
    }
  }

  // ---------------------------------------------------------------- auth
  register(peer, d) {
    const err = this.accounts.register(d.user, d.pass);
    if (err) return this.send(peer, C.AUTH_FAIL, { msg: err });
    this.log(`register  ${d.user}`);
    this.login(peer, d);
  }

  login(peer, d) {
    const err = this.accounts.check(d.user, d.pass);
    if (err) { this.log(`login FAIL ${d.user}: ${err}`); return this.send(peer, C.AUTH_FAIL, { msg: err }); }
    const acc = this.accounts.get(d.user);
    const key = acc.user.toLowerCase();
    const existing = this.byUser.get(key);
    if (existing && existing !== peer) {
      // One active session per user. A second login is REJECTED, unless it presents the private
      // resume token of the existing session: that is the same player's bridge reconnecting
      // (e.g. Wi-Fi came back before the server noticed the old session was dead).
      if (!(typeof d.resume === 'string' && existing.resume && d.resume === existing.resume)) {
        this.log(`login REJECTED ${acc.user}: already logged in from ${existing.addr}`);
        return this.send(peer, C.AUTH_FAIL, { msg: 'User already logged in elsewhere', code: 'alreadyLoggedIn' });
      }
      this.log(`login     ${acc.user} resumes its session (old transport ${existing.id} replaced)`);
      this.send(existing, C.ERROR, { code: 'replaced', msg: 'Session resumed from a new connection' });
      this.drop(existing, 'replaced');
    }
    if (peer.user && peer.user.toLowerCase() !== key) this.byUser.delete(peer.user.toLowerCase());
    peer.user = acc.user;
    peer.resume = crypto.randomBytes(12).toString('hex');
    this.byUser.set(key, peer);
    this.log(`login     ${acc.user} (${peer.id} ${peer.addr})`);
    this.send(peer, C.AUTH_OK, { user: acc.user, id: peer.id, transport: this.transport, wins: acc.wins, games: acc.games, resume: peer.resume });
    this.send(peer, C.ROOM_LIST, this.roomList());
  }

  // ---------------------------------------------------------------- lobby / rooms
  roomList() {
    const list = [];
    for (const room of this.rooms.values()) {
      const conns = this.np.getRoomConnections(room.id);
      list.push({ id: room.id, name: room.name, players: conns.length, max: MAX_PLAYERS, status: room.status,
        host: conns[0] ? conns[0].user : null, users: conns.map(p => p.user) });
    }
    return list;
  }

  members(room) { return this.np.getRoomConnections(room.id); }
  isHost(peer) {
    const room = this.rooms.get(peer.roomId);
    return !!room && this.members(room)[0] === peer;
  }

  newRoom(name) {
    const room = { id: name, name, status: 'waiting', host: null, scores: {}, scoreLimit: 0, startedAt: 0, created: Date.now(), confirms: {}, lastResult: null };
    this.rooms.set(name, room);
    return room;
  }

  createRoom(peer, name) {
    if (this.rooms.has(name)) return this.send(peer, C.ERROR, { code: 'roomExists', msg: `Room ${name} already exists` });
    if (this.rooms.size >= 50) return this.send(peer, C.ERROR, { code: 'tooManyRooms', msg: 'Too many rooms' });
    this.newRoom(name);
    this.log(`room      ${name} created by ${peer.user}`);
    this.send(peer, C.ROOM_LIST, this.roomList());
  }

  joinRoom(peer, roomId, setup) {
    if (peer.roomId && peer.roomId !== roomId) this.leaveRoom(peer, 'left');
    let room = this.rooms.get(roomId);
    if (!room) {
      if (!/^[A-Za-z0-9]{1,16}$/.test(roomId)) return this.send(peer, C.ERROR, { code: 'badRoom', msg: 'Bad room name' });
      room = this.newRoom(roomId);
    }
    if (room.status === 'playing') return this.send(peer, C.ERROR, { code: 'roomPlaying', msg: 'Game in progress, wait for it to end' });
    const res = this.np.joinRoom(roomId, peer.user, setup || 0, peer.id, peer);
    if (res === 'ok' || res === 'errorAlreadyJoined') {
      peer.roomId = roomId;
      room.confirms[peer.id] = false;
      if (res === 'ok') this.log(`join      ${peer.user} -> ${roomId} (${this.members(room).length}/${MAX_PLAYERS})`);
      this.send(peer, C.ROOM_JOINED, { room: roomId });
      this.sendStatus(room);
    } else {
      const msgs = { errorRoomFull: 'Room is full (max 4)', errorRoomFrozen: 'Game in progress' };
      this.send(peer, C.ERROR, { code: res, msg: msgs[res] || res });
    }
  }

  // reason: 'left' (clean) | 'timeout' | 'closed' | 'error' | 'bye' | 'replaced' | 'retransmit'
  leaveRoom(peer, reason) {
    const room = this.rooms.get(peer.roomId);
    peer.roomId = null;
    if (!room) return;
    const before = this.members(room);
    const wasHost = before[0] === peer;
    this.np.leaveRoom(peer.id);   // broadcasts the new ROOMCONFIG to the others
    delete room.confirms[peer.id];
    const after = this.members(room);
    if (room.scores[peer.id]) room.scores[peer.id].left = reason;
    const dropped = reason !== 'left';
    const info = { id: peer.id, user: peer.user, reason, room: room.id,
      detectMs: dropped && peer.lastSeen ? Date.now() - peer.lastSeen : 0 };
    after.forEach(p => this.send(p, dropped ? C.PLAYER_DROPPED : C.PLAYER_LEFT, info));
    this.log(`${dropped ? 'DROPPED' : 'leave  '}   ${peer.user} from ${room.id} (${reason}${dropped ? ', detected after ' + info.detectMs + ' ms silence' : ''}), ${after.length} left`);
    if (wasHost && after.length) {
      this.log(`host      ${room.id}: ${peer.user} -> ${after[0].user}`);
      after.forEach(p => this.send(p, C.HOST_CHANGED, { id: after[0].id, user: after[0].user }));
    }
    if (!after.length) {
      this.rooms.delete(room.id);
      this.log(`room      ${room.id} closed (empty)`);
      return;
    }
    if (room.status === 'playing' && after.length < 2) this.endGame(room, 'notEnoughPlayers');
    else this.sendStatus(room);
  }

  setConfirm(peer, value) {
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    room.confirms[peer.id] = !!value;
    this.np.setConfirm(peer.id, !!value);
    this.sendStatus(room);
  }

  startGame(peer, gameConfig) {
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    const members = this.members(room);
    let err = null;
    if (members[0] !== peer) err = 'Only the host can start';
    else if (room.status !== 'waiting') err = 'Already playing';
    else if (members.length < 2) err = 'Need at least 2 players';
    else if (!members.every(p => room.confirms[p.id])) err = 'Not everybody is ready';
    if (err) { this.log(`start REJECTED ${room.id}: ${err}`); return this.send(peer, C.ERROR, { code: 'cannotStart', msg: err }); }
    const res = this.np.freezeRoom(peer.id, gameConfig);   // broadcasts ROOMFROZEN (PvP start) to the others
    if (res !== 'ok') return this.send(peer, C.ERROR, { code: res, msg: res });
    room.status = 'playing';
    room.startedAt = Date.now();
    room.scoreLimit = (gameConfig.settings && +gameConfig.settings.scoreLimit) || 0;
    room.scores = {};
    room.lastKill = {};
    members.forEach((p, idx) => { room.scores[p.id] = { id: p.id, user: p.user, slot: idx, score: 0, kills: 0, deaths: 0, left: null }; });
    this.log(`START     ${room.id}: ${members.map(p => p.user).join(', ')} scoreLimit=${room.scoreLimit || 'none'}`);
    this.sendStatus(room);
    this.broadcastScoreboard(room);
  }

  // ---------------------------------------------------------------- in-game
  relayState(peer, d, reliable) {
    const room = this.rooms.get(peer.roomId);
    if (!room || room.status !== 'playing') return;
    // A pure position update (no events) is superseded 33 ms later: send it on the unreliable
    // channel (UDP) / allow dropping it under backpressure (TCP). Events stay reliable.
    this._reliable = reliable && d[1].length > 0;
    try { this.np.broadcast(peer.id, C.DATA, d); } finally { this._reliable = true; }
  }

  relayEvent(peer, d) {
    const room = this.rooms.get(peer.roomId);
    if (!room || room.status !== 'playing') return;
    const target = this.peers.get(d[0]);
    if (!target || target.roomId !== room.id) return;  // never deliver across rooms
    this.np.send(d[0], C.EVENT, d[1]);
  }

  scoreEvent(peer, d) {
    const room = this.rooms.get(peer.roomId);
    if (!room || room.status !== 'playing') return;
    // Sanity checks: only the victim's own client reports its death, at most every 400 ms.
    if (d.victim !== peer.id) { if (this.metrics) this.metrics.inc('scoreRejected'); return; }
    const now = Date.now();
    if (now - (room.lastKill[peer.id] || 0) < 400) { if (this.metrics) this.metrics.inc('scoreRejected'); return; }
    room.lastKill[peer.id] = now;
    const victim = room.scores[peer.id];
    if (!victim) return;
    victim.deaths++;
    let killer = null;
    if (d.kind === 'kill' && d.killer && d.killer !== d.victim) killer = room.scores[d.killer];
    if (killer && !killer.left) { killer.kills++; killer.score++; }
    else if (d.kind === 'suicide' || !d.killer || d.killer === d.victim) victim.score = Math.max(0, victim.score - 1);
    this.log(`score     ${room.id}: ${killer ? killer.user + ' fragged ' : ''}${victim.user}${killer ? '' : ' suicided'}`);
    this.broadcastScoreboard(room);
    if (killer && room.scoreLimit && killer.score >= room.scoreLimit) this.endGame(room, 'scoreLimit');
  }

  ranking(room) {
    const arr = Object.values(room.scores).map(s => Object.assign({}, s));
    arr.sort((a, b) => (!!a.left - !!b.left) || (b.score - a.score) || (b.kills - a.kills) || (a.deaths - b.deaths) || (a.slot - b.slot));
    let rank = 0, prev = null;
    arr.forEach((s, i) => {
      const key = (s.left ? 'L' : '') + s.score + '/' + s.kills + '/' + s.deaths;
      if (key !== prev) rank = i + 1;
      prev = key;
      s.rank = rank;
    });
    return arr;
  }

  broadcastScoreboard(room) {
    const sb = { room: room.id, scoreLimit: room.scoreLimit, ranking: this.ranking(room), elapsed: Date.now() - room.startedAt };
    this.members(room).forEach(p => this.send(p, C.SCOREBOARD, sb));
  }

  endGame(room, reason) {
    if (room.status !== 'playing') return;
    room.status = 'waiting';
    const ranking = this.ranking(room);
    const active = ranking.filter(r => !r.left);
    const draw = active.length > 1 && active[0].rank === active[1].rank;
    const winner = active.length && !draw ? active[0].user : null;
    const result = { room: room.id, reason, ranking, winner, draw, durationMs: Date.now() - room.startedAt, scoreLimit: room.scoreLimit };
    room.lastResult = result;
    // persist simple stats
    ranking.forEach(r => { const a = this.accounts.get(r.user); if (a) { a.games = (a.games || 0) + 1; if (r.user === winner) a.wins = (a.wins || 0) + 1; } });
    this.accounts.save();
    this.log(`END       ${room.id} (${reason}) winner=${winner || (draw ? 'DRAW' : '-')} ranking=${ranking.map(r => `${r.rank}.${r.user}:${r.score}${r.left ? '(' + r.left + ')' : ''}`).join(' ')}`);
    this.members(room).forEach(p => this.send(p, C.GAME_RESULT, result));
    this.np.unfreezeRoom(room.id);
    for (const k in room.confirms) room.confirms[k] = false;
    this.sendStatus(room);
  }

  sendStatus(room) {
    if (!this.rooms.has(room.id)) return;
    const members = this.members(room);
    const st = { room: room.id, status: room.status, host: members[0] ? members[0].id : null,
      players: members.map((p, i) => ({ id: p.id, user: p.user, host: i === 0, ready: !!room.confirms[p.id], ping: p.rtt, addr: p.addr })) };
    members.forEach(p => this.send(p, C.SESSION_STATUS, st, false));
  }

  // ---------------------------------------------------------------- disconnects
  drop(peer, reason) {
    if (!peer || peer.gone) return;
    try {
      if (peer.roomId) this.leaveRoom(peer, reason);
    } catch (e) { this.log('drop/leave error (ignored)', e.message); }
    peer.gone = true;
    this.peers.delete(peer.id);
    if (peer.user && this.byUser.get(peer.user.toLowerCase()) === peer) this.byUser.delete(peer.user.toLowerCase());
    this.log(`disconnect ${peer.id} ${peer.user || '(not logged in)'} reason=${reason}`);
    if (this.onDropped) { try { this.onDropped(peer, reason); } catch (e) { } }
  }

  tick() {
    const now = Date.now();
    for (const peer of Array.from(this.peers.values())) {
      if (now - peer.lastSeen > this.heartbeatTimeout) {
        if (this.metrics) this.metrics.inc('heartbeatDrops');
        this.drop(peer, 'timeout');
      }
    }
    if (now - this.lastScoreboard >= 1000) {
      this.lastScoreboard = now;
      for (const room of this.rooms.values()) {
        this.sendStatus(room);
        if (room.status === 'playing') this.broadcastScoreboard(room);
      }
      // empty rooms created but never joined expire after 60 s
      for (const room of Array.from(this.rooms.values()))
        if (!this.members(room).length && now - room.created > 60000) this.rooms.delete(room.id);
    }
  }
}

module.exports = { Session, Accounts, NAMES };
