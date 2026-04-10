// server.js - Gotcraft сервер (Node.js + Express + Socket.IO)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Хранилища (сохраняются в файлы)
let users = fs.existsSync('users.json') ? JSON.parse(fs.readFileSync('users.json')) : {};
let worlds = fs.existsSync('worlds.json') ? JSON.parse(fs.readFileSync('worlds.json')) : {};

const saveUsers = () => fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
const saveWorlds = () => fs.writeFileSync('worlds.json', JSON.stringify(worlds, null, 2));

// Генерация плоского мира
function generateInitialBlocks() {
  const blocks = {};
  for (let x = -20; x <= 20; x++) {
    for (let z = -20; z <= 20; z++) {
      blocks[`${x}_0_${z}`] = 'grass';
      blocks[`${x}_-1_${z}`] = 'dirt';
      for (let y = -2; y >= -5; y--) blocks[`${x}_${y}_${z}`] = 'stone';
    }
  }
  return blocks;
}

io.on('connection', (socket) => {
  console.log('Игрок подключился:', socket.id);

  // === Аутентификация ===
  socket.on('register', (data) => {
    if (users[data.username]) return socket.emit('auth_error', 'Пользователь уже существует');
    users[data.username] = { password: data.password };
    saveUsers();
    socket.emit('auth_success', { username: data.username });
  });

  socket.on('login', (data) => {
    if (users[data.username] && users[data.username].password === data.password) {
      socket.emit('auth_success', { username: data.username });
    } else {
      socket.emit('auth_error', 'Неверный логин или пароль');
    }
  });

  // === Миры ===
  socket.on('create_world', (data) => {
    const worldId = 'world_' + Date.now();
    worlds[worldId] = {
      name: data.name,
      owner: data.username,
      settings: data.settings,
      blocks: generateInitialBlocks(),
      public: false
    };
    saveWorlds();
    socket.emit('world_created', { worldId, name: data.name });
  });

  socket.on('get_world_list', () => {
    const list = Object.entries(worlds).map(([id, w]) => ({
      id, name: w.name, owner: w.owner
    }));
    socket.emit('world_list', list);
  });

  socket.on('join_world', (data) => {
    const world = worlds[data.worldId];
    if (!world) return;
    socket.join(data.worldId);
    socket.worldId = data.worldId;
    socket.emit('world_data', {
      worldId: data.worldId,
      blocks: world.blocks,
      settings: world.settings,
      name: world.name
    });
  });

  // === Игровые события ===
  socket.on('player_move', (data) => {
    if (!socket.worldId) return;
    socket.to(socket.worldId).emit('player_moved', {
      id: socket.id,
      position: data.position,
      rotation: data.rotation
    });
  });

  socket.on('block_update', (data) => {
    if (!socket.worldId || !worlds[socket.worldId]) return;
    const key = `${data.x}_${data.y}_${data.z}`;
    if (data.type === null) {
      delete worlds[socket.worldId].blocks[key];
    } else {
      worlds[socket.worldId].blocks[key] = data.type;
    }
    saveWorlds();
    io.to(socket.worldId).emit('block_updated', data);
  });

  socket.on('chat_message', (data) => {
    if (!socket.worldId) return;
    io.to(socket.worldId).emit('chat_message', {
      username: data.username,
      message: data.message
    });
  });

  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Gotcraft сервер запущен на порту ${PORT}`));