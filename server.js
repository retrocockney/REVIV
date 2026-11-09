'use strict';

const http = require('node:http');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 8;
const MATCH_LENGTH_MS = 5 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 2 * 60 * 1000;
const VALID_MAPS = new Set(['og', 'mini', 'house', 'lab']);
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const body = JSON.stringify({ ok: true, service: 'liteshot-online-v2', rooms: rooms.size, uptime: Math.floor(process.uptime()) });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
});

function safeText(value, max = 24) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function safeColor(value, fallback = 0x00ffcc) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 0xffffff ? Math.floor(n) : fallback;
}
function safeNumber(value, fallback = 0, min = -500, max = 500) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while ([...rooms.values()].some(room => room.code === code));
  return code;
}
function roomKey(map, code) { return `${map}:${code}`; }
function getSocketRoom(socket) {
  const key = socket.data.roomKey;
  return key ? rooms.get(key) : null;
}
function getPlayer(socket) {
  const room = getSocketRoom(socket);
  return room ? room.players.get(socket.id) : null;
}
function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    visor: player.visor,
    helmet: player.helmet,
    armor: player.armor,
    emblem: player.emblem,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    kills: player.kills,
    deaths: player.deaths,
  };
}
function roomPlayersObject(room) {
  const result = {};
  for (const [id, player] of room.players) result[id] = publicPlayer(player);
  return result;
}
function createRoom(map, mode, isPrivate) {
  const code = makeCode();
  const key = roomKey(map, code);
  const room = {
    key, code, map, mode, isPrivate,
    players: new Map(),
    pickupSpots: null,
    pickupTimers: new Map(),
    vehicleStates: new Map(),
    matchEndsAt: 0,
    matchTimer: null,
    emptyTimer: null,
    ended: false,
  };
  rooms.set(key, room);
  return room;
}
function startMatch(room, resetScores = false) {
  if (room.matchTimer) clearTimeout(room.matchTimer);
  if (resetScores) {
    for (const p of room.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.health = 100;
      p.alive = true;
      p.pendingDeath = false;
    }
  }
  room.ended = false;
  room.matchEndsAt = Date.now() + MATCH_LENGTH_MS;
  io.to(room.key).emit('matchStart', { msRemaining: MATCH_LENGTH_MS });
  room.matchTimer = setTimeout(() => endMatch(room), MATCH_LENGTH_MS);
}
function endMatch(room) {
  if (!room || !rooms.has(room.key) || room.ended) return;
  room.ended = true;
  const scores = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  io.to(room.key).emit('matchEnd', { scores });
}
function findPickup(room, kind, id) {
  const key = kind === 'weapon' ? 'weapons' : kind === 'kit' ? 'kits' : 'grenades';
  const list = room.pickupSpots && Array.isArray(room.pickupSpots[key]) ? room.pickupSpots[key] : [];
  return list.find(item => String(item.id) === String(id));
}
function pickupRespawnMs(kind, item) {
  if (kind === 'weapon') return item && item.type === 'crowbar' ? 6500 : 12000;
  if (kind === 'kit') return 15000;
  return 10000;
}
function leaveRoom(socket) {
  const room = getSocketRoom(socket);
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(room.key);
  socket.data.roomKey = null;
  if (player) io.to(room.key).emit('playerDisconnected', socket.id);
  if (room.players.size === 0) {
    if (room.matchTimer) clearTimeout(room.matchTimer);
    room.matchTimer = null;
    room.matchEndsAt = 0;
    room.ended = false;
    for (const t of room.pickupTimers.values()) clearTimeout(t);
    room.emptyTimer = setTimeout(() => {
      if (room.players.size === 0) rooms.delete(room.key);
    }, EMPTY_ROOM_TTL_MS);
  }
}

io.on('connection', socket => {
  socket.data.roomKey = null;
  socket.data.lastJoinAt = 0;

  socket.on('joinRoom', (payload = {}, callback = () => {}) => {
    try {
      const now = Date.now();
      if (now - socket.data.lastJoinAt < 500) return callback({ ok: false, error: 'Please wait a moment before joining again.' });
      socket.data.lastJoinAt = now;
      if (socket.data.roomKey) leaveRoom(socket);

      const map = VALID_MAPS.has(payload.map) ? payload.map : 'og';
      const mode = payload.mode === 'wipeout' ? 'wipeout' : 'pvp';
      if (mode === 'wipeout') return callback({ ok: false, error: 'Online co-op is not part of this PvP rebuild yet. Choose PVP online.' });

      let room = null;
      if (payload.quick) {
        room = [...rooms.values()]
          .filter(r => !r.isPrivate && r.map === map && r.mode === mode && r.players.size < MAX_PLAYERS && !r.ended)
          .sort((a, b) => b.players.size - a.players.size)[0] || null;
        if (!room) room = createRoom(map, mode, false);
      } else if (payload.create) {
        room = createRoom(map, mode, true);
      } else {
        const code = safeText(payload.roomCode, 6).toUpperCase();
        room = rooms.get(roomKey(map, code)) || null;
        if (!room) return callback({ ok: false, error: 'Room not found. Check the code and map.' });
      }

      if (room.players.size >= MAX_PLAYERS) return callback({ ok: false, error: 'That room is full.' });
      if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }

      const player = {
        id: socket.id,
        name: safeText(payload.name, 18) || 'Operative',
        color: safeColor(payload.color),
        visor: safeColor(payload.visor, safeColor(payload.color)),
        helmet: ['visor', 'full', 'scout'].includes(payload.helmet) ? payload.helmet : 'visor',
        armor: ['heavy', 'light', 'none'].includes(payload.armor) ? payload.armor : 'heavy',
        emblem: typeof payload.emblem === 'string' && payload.emblem.startsWith('data:image/') && payload.emblem.length <= 100000 ? payload.emblem : null,
        x: 0, y: 1.7, z: 0, yaw: 0,
        health: 100, alive: true, pendingDeath: false,
        kills: 0, deaths: 0,
        lastMoveAt: 0, lastChatAt: 0,
        hitTimes: new Map(),
      };
      room.players.set(socket.id, player);
      socket.data.roomKey = room.key;
      socket.join(room.key);

      // Give the joining client a full snapshot, then tell everyone else about the newcomer.
      socket.emit('currentPlayers', roomPlayersObject(room));
      socket.to(room.key).emit('newPlayer', publicPlayer(player));
      if (room.pickupSpots) socket.emit('pickupState', room.pickupSpots);
      else socket.emit('requestPickupSpots');
      if (!room.matchEndsAt || room.ended) startMatch(room);
      else socket.emit('matchStart', { msRemaining: Math.max(0, room.matchEndsAt - Date.now()) });

      callback({ ok: true, roomCode: room.code, map: room.map, players: room.players.size, maxPlayers: MAX_PLAYERS });
    } catch (err) {
      console.error('joinRoom failed:', err);
      callback({ ok: false, error: 'The server could not join that room.' });
    }
  });

  socket.on('leaveRoom', () => leaveRoom(socket));

  socket.on('setIdentity', (data = {}) => {
    const room = getSocketRoom(socket), player = getPlayer(socket);
    if (!room || !player) return;
    player.name = safeText(data.name, 18) || player.name;
    player.color = safeColor(data.color, player.color);
    player.visor = safeColor(data.visor, player.color);
    player.helmet = ['visor', 'full', 'scout'].includes(data.helmet) ? data.helmet : player.helmet;
    player.armor = ['heavy', 'light', 'none'].includes(data.armor) ? data.armor : player.armor;
    player.emblem = typeof data.emblem === 'string' && data.emblem.startsWith('data:image/') && data.emblem.length <= 100000 ? data.emblem : null;
    io.to(room.key).emit('playerIdentity', { id: socket.id, ...publicPlayer(player) });
  });

  socket.on('playerMovement', data => {
    const room = getSocketRoom(socket), player = getPlayer(socket);
    if (!room || !player || !data) return;
    const now = Date.now();
    if (now - player.lastMoveAt < 35) return;
    const next = {
      x: safeNumber(data.x, player.x, -500, 500),
      y: safeNumber(data.y, player.y, -100, 120),
      z: safeNumber(data.z, player.z, -500, 500),
      yaw: safeNumber(data.yaw, player.yaw, -1000, 1000),
    };
    if (player.lastMoveAt) {
      const dt = Math.max(0.035, (now - player.lastMoveAt) / 1000);
      const dist = Math.hypot(next.x - player.x, next.y - player.y, next.z - player.z);
      if (dist > Math.max(6, dt * 95 + 2)) return;
    }
    player.lastMoveAt = now;
    Object.assign(player, next);
    socket.to(room.key).emit('playerMoved', { id: socket.id, ...next });
  });

  socket.on('hitPlayer', data => {
    const room = getSocketRoom(socket), attacker = getPlayer(socket);
    if (!room || !attacker || !data || !attacker.alive) return;
    const targetId = safeText(data.targetId, 64);
    const target = room.players.get(targetId);
    if (!target || target.id === attacker.id || !target.alive || target.pendingDeath) return;
    const weapon = safeText(data.weapon, 32) || 'Weapon';
    const damage = Math.max(1, Math.min(200, Math.floor(Number(data.damage) || 0)));
    const now = Date.now();
    const cooldowns = {
      'Shotgun': 240, 'Sniper': 650, 'Rocket Launcher': 500, 'SMG': 85,
      'Revolver': 380, 'Chaingun': 65, 'Chainsaw': 180, 'Lawnmower': 200,
      'Crowbar': 250, 'Grenade': 450, 'Rifle': 120, 'Pistol': 220,
    };
    const key = `${targetId}:${weapon}`;
    const cooldown = cooldowns[weapon] || 150;
    if (now - (attacker.hitTimes.get(key) || 0) < cooldown) return;
    attacker.hitTimes.set(key, now);
    target.health = Math.max(0, target.health - damage);
    if (target.health <= 0) target.pendingDeath = true;
    io.to(target.id).emit('playerHit', { damage, attackerId: attacker.id, weapon });
  });

  socket.on('playerDied', data => {
    const room = getSocketRoom(socket), victim = getPlayer(socket);
    if (!room || !victim || !victim.alive) return;
    const killerId = data && room.players.has(data.killerId) && data.killerId !== socket.id ? data.killerId : null;
    // Non-combat deaths (falls / map hazards) are allowed. Combat deaths must follow a server-approved hit.
    if (killerId && !victim.pendingDeath) return;
    victim.alive = false;
    victim.pendingDeath = false;
    victim.deaths++;
    victim.health = 0;
    const killer = killerId ? room.players.get(killerId) : null;
    if (killer) killer.kills++;
    io.to(room.key).emit('playerDown', {
      victimId: socket.id,
      victimName: victim.name,
      killerId,
      killerName: killer ? killer.name : 'Environment',
      weapon: safeText(data && data.weapon, 40) || 'Unknown',
    });
    setTimeout(() => {
      const stillHere = room.players.get(socket.id);
      if (!stillHere) return;
      stillHere.alive = true;
      stillHere.pendingDeath = false;
      stillHere.health = 100;
    }, 2300);
  });

  socket.on('chat', data => {
    const room = getSocketRoom(socket), player = getPlayer(socket);
    if (!room || !player || !data) return;
    const now = Date.now();
    if (now - player.lastChatAt < 450) return;
    const text = safeText(data.text, 140);
    if (!text) return;
    player.lastChatAt = now;
    io.to(room.key).emit('chat', { id: socket.id, name: player.name, text });
  });

  socket.on('pickupSpots', spots => {
    const room = getSocketRoom(socket);
    if (!room || room.pickupSpots || !spots || typeof spots !== 'object') return;
    const cleanList = (list, kind, max) => Array.isArray(list) ? list.slice(0, max).map((item, i) => ({
      id: safeText(item && item.id, 24) || `${kind}${i}`,
      x: safeNumber(item && item.x, 0), y: safeNumber(item && item.y, 0, -30, 80), z: safeNumber(item && item.z, 0),
      ...(kind === 'w' ? { type: safeText(item && item.type, 24) || 'crowbar' } : {}),
      active: item && item.active !== false,
    })) : [];
    room.pickupSpots = {
      weapons: cleanList(spots.weapons, 'w', 80),
      kits: cleanList(spots.kits, 'k', 30),
      grenades: cleanList(spots.grenades, 'g', 30),
    };
    io.to(room.key).emit('pickupState', room.pickupSpots);
  });

  socket.on('pickupTaken', data => {
    const room = getSocketRoom(socket);
    if (!room || !data) return;
    const kind = ['weapon', 'kit', 'grenade'].includes(data.kind) ? data.kind : null;
    if (!kind) return;
    const id = safeText(data.id, 24);
    const item = findPickup(room, kind, id);
    if (!item || item.active === false) return;
    item.active = false;
    io.to(room.key).emit('pickupTaken', { kind, id });
    const timerKey = `${kind}:${id}`;
    if (room.pickupTimers.has(timerKey)) clearTimeout(room.pickupTimers.get(timerKey));
    const timer = setTimeout(() => {
      item.active = true;
      room.pickupTimers.delete(timerKey);
      io.to(room.key).emit('pickupRespawn', { kind, id });
    }, pickupRespawnMs(kind, item));
    room.pickupTimers.set(timerKey, timer);
  });

  socket.on('restartMatch', () => {
    const room = getSocketRoom(socket);
    if (!room) return;
    startMatch(room, true);
  });

  // Small compatibility bridge for the game's remaining drivable-object state.
  socket.on('mountVehicle', data => {
    const room = getSocketRoom(socket);
    if (!room || !data) return;
    const id = safeText(data.id, 40);
    const existing = room.vehicleStates.get(id) || { id };
    if (existing.riderId && existing.riderId !== socket.id) {
      socket.emit('mountDenied', { id });
      return;
    }
    existing.riderId = socket.id;
    room.vehicleStates.set(id, existing);
    io.to(room.key).emit('vehicleChanged', existing);
  });
  socket.on('dismountVehicle', data => {
    const room = getSocketRoom(socket);
    if (!room || !data) return;
    const id = safeText(data.id, 40);
    const existing = room.vehicleStates.get(id) || { id };
    if (existing.riderId === socket.id) existing.riderId = null;
    existing.x = safeNumber(data.x, existing.x || 0);
    existing.z = safeNumber(data.z, existing.z || 0);
    room.vehicleStates.set(id, existing);
    io.to(room.key).emit('vehicleChanged', existing);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LITESHOT online server listening on ${PORT}`);
});
