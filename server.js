const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Папка данных
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');

let users = {};
let worlds = {};

try {
  if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  else fs.writeFileSync(USERS_FILE, '{}');
  if (fs.existsSync(WORLDS_FILE)) worlds = JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
  else fs.writeFileSync(WORLDS_FILE, '{}');
} catch (e) { console.error(e); }

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveWorlds() { fs.writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2)); }

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (users[username]) return res.status(400).json({ error: 'Пользователь уже существует' });
  users[username] = { password, createdAt: new Date().toISOString() };
  saveUsers();
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Неверные данные' });
  res.json({ success: true });
});

// Генерация чанка с гарантированным спавном на земле
function generateChunk(worldId, chunkX, chunkY) {
  const seed = worldId.split('').reduce((a,b)=>a+b.charCodeAt(0),0);
  const blocks = {};
  const size = 16;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const wx = chunkX * size + x;
      const wy = chunkY * size + y;
      // Простой ландшафт: высота земли = 64 + шум
      const noise = Math.sin(wx * 0.1 + seed) * Math.cos(wy * 0.1 + seed) * 5;
      const groundHeight = 64 + Math.floor(noise);
      if (wy < groundHeight - 3) blocks[`${wx},${wy}`] = 'stone';
      else if (wy < groundHeight) blocks[`${wx},${wy}`] = 'dirt';
      else if (wy === groundHeight) blocks[`${wx},${wy}`] = 'grass';
      // Добавим немного руды
      if (wy < groundHeight && wy > 20 && Math.random() < 0.02) blocks[`${wx},${wy}`] = 'stone';
    }
  }
  // Гарантируем платформу на спавне (0,64)
  if (chunkX === 0 && chunkY === 4) { // 4*16=64
    for (let dx = -2; dx <= 2; dx++) {
      blocks[`${dx},64`] = 'grass';
    }
  }
  return blocks;
}

const activeWorlds = {};
Object.entries(worlds).forEach(([id, data]) => {
  activeWorlds[id] = {
    id, name: data.name, settings: data.settings,
    blocks: data.blocks || {},
    players: {},
    chatMessages: data.chatMessages || [],
  };
});

function createWorld(owner, name, settings) {
  const id = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const world = { id, name, settings, blocks: {}, players: {}, chatMessages: [], owner };
  activeWorlds[id] = world;
  worlds[id] = { name, settings, blocks: world.blocks, chatMessages: [] };
  saveWorlds();
  return world;
}

function saveWorldState(worldId) {
  const w = activeWorlds[worldId];
  if (!w) return;
  worlds[worldId] = { name: w.name, settings: w.settings, blocks: w.blocks, chatMessages: w.chatMessages };
  saveWorlds();
}

io.on('connection', (socket) => {
  console.log('🟢 Подключение:', socket.id);
  let currentUsername = null;
  let currentWorldId = null;

  socket.on('auth', ({ username }) => {
    if (!users[username]) return socket.emit('auth_error', 'Пользователь не найден');
    currentUsername = username;
    socket.emit('auth_success', { username });
  });

  socket.on('get_worlds', () => {
    const list = Object.values(activeWorlds).map(w => ({
      id: w.id, name: w.name, players: Object.keys(w.players).length, settings: w.settings
    }));
    socket.emit('worlds_list', list);
  });

  socket.on('create_world', ({ name, settings }) => {
    if (!currentUsername) return;
    const world = createWorld(currentUsername, name, settings);
    socket.join(world.id);
    currentWorldId = world.id;
    world.players[socket.id] = { username: currentUsername, x: 0, y: 70, health: 20, hunger: 20, gamemode: settings.gameMode };
    socket.emit('world_created', { worldId: world.id, worldName: world.name, settings: world.settings });
  });

  socket.on('join_world', ({ worldId }) => {
    if (!currentUsername) return;
    const world = activeWorlds[worldId];
    if (!world) return socket.emit('error', 'Мир не найден');
    socket.join(worldId);
    currentWorldId = worldId;
    world.players[socket.id] = { username: currentUsername, x: 0, y: 70, health: 20, hunger: 20, gamemode: world.settings.gameMode };

    // Генерируем чанки вокруг спавна
    const nearbyBlocks = {};
    for (let cx = -3; cx <= 3; cx++) {
      for (let cy = 2; cy <= 5; cy++) { // y-чанки от 32 до 80 примерно
        Object.assign(nearbyBlocks, generateChunk(worldId, cx, cy));
      }
    }
    Object.assign(world.blocks, nearbyBlocks);
    socket.emit('world_data', {
      worldId: world.id,
      worldName: world.name,
      settings: world.settings,
      blocks: nearbyBlocks,
      players: world.players,
      chatMessages: world.chatMessages,
    });
    socket.to(worldId).emit('player_joined', { id: socket.id, username: currentUsername, x: 0, y: 70 });
    saveWorldState(worldId);
  });

  socket.on('request_chunk', ({ chunkX, chunkY }) => {
    if (!currentWorldId) return;
    const world = activeWorlds[currentWorldId];
    if (!world) return;
    const blocks = generateChunk(currentWorldId, chunkX, chunkY);
    Object.assign(world.blocks, blocks);
    socket.emit('chunk_data', { chunkX, chunkY, blocks });
    saveWorldState(currentWorldId);
  });

  socket.on('player_update', (data) => {
    if (!currentWorldId) return;
    const world = activeWorlds[currentWorldId];
    if (!world || !world.players[socket.id]) return;
    const player = world.players[socket.id];
    player.x = data.x; player.y = data.y; player.health = data.health; player.hunger = data.hunger;
    socket.to(currentWorldId).emit('player_moved', { id: socket.id, x: data.x, y: data.y });
  });

  socket.on('block_action', ({ x, y, action, blockType }) => {
    if (!currentWorldId) return;
    const world = activeWorlds[currentWorldId];
    if (!world) return;
    const key = `${x},${y}`;
    if (action === 'break') delete world.blocks[key];
    else world.blocks[key] = blockType || 'stone';
    io.to(currentWorldId).emit('block_update', { x, y, type: action === 'break' ? null : world.blocks[key] });
    saveWorldState(currentWorldId);
  });

  socket.on('chat_message', ({ message }) => {
    if (!currentWorldId || !currentUsername) return;
    const world = activeWorlds[currentWorldId];
    if (!world) return;
    const msg = { username: currentUsername, message, timestamp: Date.now() };
    world.chatMessages.push(msg);
    if (world.chatMessages.length > 50) world.chatMessages.shift();
    io.to(currentWorldId).emit('chat_message', msg);
    saveWorldState(currentWorldId);
  });

  socket.on('disconnect', () => {
    if (currentWorldId && currentUsername) {
      const world = activeWorlds[currentWorldId];
      if (world) {
        delete world.players[socket.id];
        io.to(currentWorldId).emit('player_left', { id: socket.id, username: currentUsername });
        saveWorldState(currentWorldId);
      }
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Gotcraft server running on port ${PORT}`));