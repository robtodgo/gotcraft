const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Пути к файлам данных
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');

// Загрузка данных
let users = {};
let worlds = {};

try {
  if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE));
  if (fs.existsSync(WORLDS_FILE)) worlds = JSON.parse(fs.readFileSync(WORLDS_FILE));
} catch (e) {
  console.error('Ошибка загрузки данных:', e);
}

// Сохранение данных
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function saveWorlds() {
  fs.writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2));
}

// ========== API для регистрации/входа ==========
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (users[username]) return res.status(400).json({ error: 'User already exists' });
  users[username] = { password, createdAt: new Date().toISOString() };
  saveUsers();
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ success: true });
});

// ========== Socket.IO логика ==========
// Хранилище активных игроков и миров
const activeWorlds = {}; // worldId -> { name, settings, blocks, players, chatMessages, ... }
const playerSockets = {}; // socketId -> { username, currentWorld, ... }

// Инициализация миров из файла
Object.entries(worlds).forEach(([id, world]) => {
  activeWorlds[id] = {
    id,
    name: world.name,
    settings: world.settings,
    blocks: world.blocks || {},
    players: {},
    chatMessages: world.chatMessages || [],
  };
});

// Функция создания нового мира
function createWorld(owner, name, settings) {
  const id = Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  const world = {
    id,
    name,
    settings,
    blocks: {},
    players: {},
    chatMessages: [],
    owner,
  };
  activeWorlds[id] = world;
  worlds[id] = { name, settings, blocks: world.blocks, chatMessages: [] };
  saveWorlds();
  return world;
}

// Сохранение состояния мира
function saveWorldState(worldId) {
  const world = activeWorlds[worldId];
  if (!world) return;
  worlds[worldId] = {
    name: world.name,
    settings: world.settings,
    blocks: world.blocks,
    chatMessages: world.chatMessages,
  };
  saveWorlds();
}

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

  // Аутентификация
  socket.on('auth', ({ username }) => {
    if (!users[username]) {
      socket.emit('auth_error', 'User not found');
      return;
    }
    playerSockets[socket.id] = { username, currentWorld: null };
    socket.emit('auth_success', { username });
  });

  // Получение списка доступных миров (для сетевой игры)
  socket.on('get_worlds', () => {
    const list = Object.values(activeWorlds).map(w => ({
      id: w.id,
      name: w.name,
      players: Object.keys(w.players).length,
      settings: w.settings,
    }));
    socket.emit('worlds_list', list);
  });

  // Создание нового мира (одиночная игра)
  socket.on('create_world', ({ name, settings }) => {
    const player = playerSockets[socket.id];
    if (!player) return;
    const world = createWorld(player.username, name, settings);
    player.currentWorld = world.id;
    socket.join(world.id);
    world.players[socket.id] = { username: player.username, x: 0, y: 70, mode: settings.gameMode };
    socket.emit('world_created', { worldId: world.id, worldName: world.name, settings: world.settings });
    // Отправляем начальные блоки (чанк вокруг спавна)
    sendNearbyBlocks(socket, world, 0, 70);
  });

  // Присоединение к существующему миру (сетевая игра)
  socket.on('join_world', ({ worldId }) => {
    const player = playerSockets[socket.id];
    const world = activeWorlds[worldId];
    if (!player || !world) return;
    player.currentWorld = worldId;
    socket.join(worldId);
    world.players[socket.id] = { username: player.username, x: 0, y: 70, mode: world.settings.gameMode };
    socket.emit('world_joined', { worldId, worldName: world.name, settings: world.settings });
    sendNearbyBlocks(socket, world, 0, 70);
    // Оповещаем других игроков
    socket.to(worldId).emit('player_joined', { username: player.username });
  });

  // Получение блоков вокруг позиции
  function sendNearbyBlocks(socket, world, cx, cy) {
    const chunkSize = 16;
    const blocks = {};
    const startX = Math.floor(cx / chunkSize) * chunkSize - chunkSize;
    const endX = startX + chunkSize * 3;
    const startY = Math.floor(cy / chunkSize) * chunkSize - chunkSize;
    const endY = startY + chunkSize * 3;
    for (let x = startX; x < endX; x++) {
      for (let y = startY; y < endY; y++) {
        const key = `${x},${y}`;
        if (world.blocks[key]) blocks[key] = world.blocks[key];
      }
    }
    socket.emit('world_blocks', blocks);
  }

  // Установка/разрушение блока
  socket.on('block_action', ({ worldId, x, y, action, blockType }) => {
    const world = activeWorlds[worldId];
    if (!world) return;
    const player = world.players[socket.id];
    if (!player) return;
    const key = `${x},${y}`;
    if (action === 'break') {
      delete world.blocks[key];
    } else if (action === 'place') {
      if (player.mode === 'survival') {
        // Проверка наличия блока в инвентаре (клиент сам отслеживает)
      }
      world.blocks[key] = blockType || 'stone';
    }
    io.to(worldId).emit('block_update', { x, y, type: action === 'break' ? null : world.blocks[key] });
    saveWorldState(worldId);
  });

  // Перемещение игрока
  socket.on('player_move', ({ worldId, x, y }) => {
    const world = activeWorlds[worldId];
    if (!world) return;
    const player = world.players[socket.id];
    if (player) {
      player.x = x;
      player.y = y;
      socket.to(worldId).emit('player_moved', { id: socket.id, x, y });
    }
  });

  // Чат
  socket.on('chat_message', ({ worldId, message }) => {
    const world = activeWorlds[worldId];
    const player = playerSockets[socket.id];
    if (!world || !player) return;
    const chatMsg = { username: player.username, message, timestamp: Date.now() };
    world.chatMessages.push(chatMsg);
    if (world.chatMessages.length > 50) world.chatMessages.shift();
    io.to(worldId).emit('chat_message', chatMsg);
    saveWorldState(worldId);
  });

  // Отключение
  socket.on('disconnect', () => {
    const player = playerSockets[socket.id];
    if (player && player.currentWorld) {
      const world = activeWorlds[player.currentWorld];
      if (world) {
        delete world.players[socket.id];
        socket.to(player.currentWorld).emit('player_left', { username: player.username });
      }
    }
    delete playerSockets[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Сервер Gotcraft запущен на порту ${PORT}`);
});