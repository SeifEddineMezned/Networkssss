// Shared message schema for BOTH transports (TCP and UDP).
// A message is a JSON object {t:<code>, d:<payload>} (+ transport header fields on UDP).
// Codes 0..13 and 100 are the original PvP NETCODEs (client/js/netplay-server.js),
// codes >= 20 are ours.

const C = {
  // --- PvP original (client -> server)
  JOINROOM: 0, LEAVEROOM: 1, SETCONFIRM: 2, FREEZEROOM: 3, UPDATESETUP: 4, BROADCAST: 5, SENDEVENT: 6,
  // --- PvP original (server -> client)
  ROOMCONFIG: 7, DATA: 8, EVENT: 9, ROOMFROZEN: 10, SETUP: 11, CONFIRM: 12, BULK: 13, UNAVAILABLE: 100,
  // --- ours
  HELLO: 20, WELCOME: 21, REGISTER: 22, LOGIN: 23, AUTH_OK: 24, AUTH_FAIL: 25,
  ROOM_LIST_REQ: 26, ROOM_LIST: 27, CREATE_ROOM: 28, PLAYER_LEFT: 29, PLAYER_DROPPED: 30,
  SCORE_EVENT: 31, SCOREBOARD: 32, GAME_RESULT: 33, PING: 34, PONG: 35, ERROR: 36, BYE: 37,
  GAME_END_REQ: 38, LOGOUT: 39, HOST_CHANGED: 40, ROOM_JOINED: 41, SESSION_STATUS: 42,
  // UDP-only transport control (never reaches session.js)
  ACK: 50,
};

const NAMES = {};
for (const k in C) NAMES[C[k]] = k;

const MAX_PACKET = 1200;           // bytes, keep every datagram/frame under this
const MAX_TCP_FRAME = 64 * 1024;   // hard cap for a TCP frame (anything bigger = protocol violation)

// Messages a client may send to the server, with a payload validator.
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const CLIENT_MSG = {
  [C.HELLO]: () => true,
  [C.REGISTER]: d => d && isStr(d.user, 3, 10) && /^[A-Za-z0-9]+$/.test(d.user) && isStr(d.pass, 3, 64),
  [C.LOGIN]: d => d && isStr(d.user, 3, 10) && isStr(d.pass, 1, 64) && (d.resume === undefined || isStr(d.resume, 1, 64)),
  [C.LOGOUT]: () => true,
  [C.ROOM_LIST_REQ]: () => true,
  [C.CREATE_ROOM]: d => d && isStr(d.name, 3, 8) && /^[A-Za-z0-9]+$/.test(d.name),
  [C.JOINROOM]: d => Array.isArray(d) && isStr(d[0], 1, 16),
  [C.LEAVEROOM]: () => true,
  [C.SETCONFIRM]: d => typeof d === 'boolean',
  [C.FREEZEROOM]: d => d && typeof d === 'object',
  [C.UPDATESETUP]: d => d && typeof d === 'object',
  [C.BROADCAST]: d => Array.isArray(d) && d.length === 2 && Array.isArray(d[0]) && Array.isArray(d[1]),
  [C.SENDEVENT]: d => Array.isArray(d) && d.length === 2,
  [C.SCORE_EVENT]: d => d && (d.kind === 'kill' || d.kind === 'suicide') && typeof d.victim === 'string',
  [C.GAME_END_REQ]: () => true,
  [C.PING]: d => d && typeof d.ts === 'number',
  [C.PONG]: d => d && typeof d.ts === 'number',
  [C.BYE]: () => true,
};

// Returns the message object, or null if it is not a valid client message.
function validateClient(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.t !== 'number') return null;
  const v = CLIENT_MSG[msg.t];
  if (!v) return null;
  try { if (!v(msg.d)) return null; } catch (e) { return null; }
  return msg;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = { C, NAMES, MAX_PACKET, MAX_TCP_FRAME, validateClient, safeParse };
