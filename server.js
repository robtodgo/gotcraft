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

// === Настройка папки данных (обязательно для Render) ===
const DATA_DIR = path.join(__dirname, 'data');
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('Папка data создана');
  }
} catch (err) {
  console.error('Не удалось создать папку data:', err);
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');

// Загрузка данных с защитой от ошибок
let users = {};
let worlds = {};

try {
  if (fs.existsSync(USERS_FILE)) {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    console.log('Загружено пользователей:', Object.keys(users).length);
  } else {
    fs.writeFileSync(USERS_FILE, '{}');
  }
} catch (e) {
  console.error('Ошибка загрузки users.json:', e);
  users = {};
}

try {
  if (fs.existsSync(WORLDS_FILE)) {
    worlds = JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
  } else {
    fs.writeFileSync(WORLDS_FILE, '{}');
  }
} catch (e) {
  console.error('Ошибка загрузки worlds.json:', e);
  worlds = {};
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения users.json:', e);
  }
}

function saveWorlds() {
  try {
    fs.writeFileSync(WORLDS_FILE, JSON.stringify(worlds, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения worlds.json:', e);
  }
}

// API регистрации и входа
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (users[username]) {
    return res.status(400).json({ error: 'User already exists' });
  }
  users[username] = { password, createdAt: new Date().toISOString() };
  saveUsers();
  console.log(`Зарегистрирован новый пользователь: ${username}`);
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ success: true });
});

// === Socket.IO логика ===
const activeWorlds = {};

// Восстановление миров из файла
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

  socket.on('auth', ({ username }) => {
    if (!users[username]) {
      socket.emit('auth_error', 'User not found');
      return;
    }
    socket.username = username;
    socket.emit('auth_success', { username });
  });

  socket.on('get_worlds', () => {
    const list = Object.values(activeWorlds).map(w => ({
      id: w.id,
      name: w.name,
      players: Object.keys(w.players).length,
      settings: w.settings,
    }));
    socket.emit('worlds_list', list);
  });

  socket.on('create_world', ({ name, settings }) => {
    if (!socket.username) return;
    const world = createWorld(socket.username, name, settings);
    socket.join(world.id);
    world.players[socket.id] = { username: socket.username, x: 0, y: 70, mode: settings.gameMode };
    socket.emit('world_created', { worldId: world.id, worldName: world.name, settings: world.settings });
  });

  socket.on('join_world', ({ worldId }) => {
    if (!socket.username) return;
    const world = activeWorlds[worldId];
    if (!world) return;
    socket.join(worldId);
    world.players[socket.id] = { username: socket.username, x: 0, y: 70, mode: world.settings.gameMode };
    socket.emit('world_joined', { worldId, worldName: world.name, settings: world.settings });
    socket.to(worldId).emit('player_joined', { username: socket.username });
  });

  socket.on('block_action', ({ worldId, x, y, action, blockType }) => {
    const world = activeWorlds[worldId];
    if (!world) return;
    const key = `${x},${y}`;
    if (action === 'break') {
      delete world.blocks[key];
    } else if (action === 'place') {
      world.blocks[key] = blockType || 'stone';
    }
    io.to(worldId).emit('block_update', { x, y, type: action === 'break' ? null : world.blocks[key] });
    saveWorldState(worldId);
  });

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

  socket.on('chat_message', ({ worldId, message }) => {
    const world = activeWorlds[worldId];
    if (!world || !socket.username) return;
    const chatMsg = { username: socket.username, message, timestamp: Date.now() };
    world.chatMessages.push(chatMsg);
    if (world.chatMessages.length > 50) world.chatMessages.shift();
    io.to(worldId).emit('chat_message', chatMsg);
    saveWorldState(worldId);
  });

  socket.on('disconnect', () => {
    if (!socket.username) return;
    for (const worldId in activeWorlds) {
      const world = activeWorlds[worldId];
      if (world.players[socket.id]) {
        delete world.players[socket.id];
        socket.to(worldId).emit('player_left', { username: socket.username });
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Сервер Gotcraft запущен на порту ${PORT}`);
});