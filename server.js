const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store. Nothing here ever holds video bytes — just
// room membership and the last known playback state (time + playing/paused).
// rooms[roomId] = { hostId, users: { socketId: name }, state: { playing, time, updatedAt }, fileName }
const rooms = {};

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms[id] ? makeRoomId() : id;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let username = null;

  socket.on('create-room', ({ name }) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      hostId: socket.id,
      users: { [socket.id]: name || 'Host' },
      state: { playing: false, time: 0, updatedAt: Date.now() },
      fileName: null
    };
    currentRoom = roomId;
    username = name || 'Host';
    socket.join(roomId);
    socket.emit('room-created', { roomId, isHost: true, selfId: socket.id });
    io.to(roomId).emit('user-list', { users: rooms[roomId].users, hostId: rooms[roomId].hostId });
  });

  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error-message', 'No room with that code is open right now.');
      return;
    }
    room.users[socket.id] = name || 'Guest';
    currentRoom = roomId;
    username = name || 'Guest';
    socket.join(roomId);
    socket.emit('room-joined', {
      roomId,
      isHost: room.hostId === socket.id,
      selfId: socket.id,
      state: room.state,
      fileName: room.fileName,
      torrents: room.torrents ? Object.values(room.torrents) : []
    });
    io.to(roomId).emit('user-list', { users: room.users, hostId: room.hostId });
    socket.to(roomId).emit('system-message', `${username} joined.`);
  });

  socket.on('set-filename', ({ fileName }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.fileName = fileName;
    socket.to(currentRoom).emit('host-filename', fileName);
  });

  // P2P share: we only ever relay the magnet URI (a text string) here —
  // the actual video bytes travel peer-to-peer over WebRTC and never
  // touch this server. Multiple people can seed the same file — WebTorrent
  // pools identical files under the same magnet URI automatically.
  socket.on('torrent-offer', ({ magnetURI, fileName }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    if (!room.torrents) room.torrents = {};
    const existing = room.torrents[magnetURI];
    const seeders = existing ? new Set(existing.seeders) : new Set();
    seeders.add(username);
    room.torrents[magnetURI] = { magnetURI, fileName, seeders: [...seeders] };
    io.to(currentRoom).emit('torrent-list', Object.values(room.torrents));
  });

  // type: 'play' | 'pause' | 'seek', time: seconds
  socket.on('playback-event', (data) => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.state = { playing: data.type !== 'pause', time: data.time, updatedAt: Date.now() };
    socket.to(currentRoom).emit('playback-event', data);
  });

  // periodic drift correction ping
  socket.on('sync-time', ({ time }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('sync-time', { time, from: socket.id });
  });

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', { name: username, msg });
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    delete room.users[socket.id];
    io.to(currentRoom).emit('system-message', `${username} left.`);

    if (room.torrents) {
      Object.values(room.torrents).forEach((t) => {
        t.seeders = t.seeders.filter((s) => s !== username);
      });
      io.to(currentRoom).emit('torrent-list', Object.values(room.torrents));
    }

    if (Object.keys(room.users).length === 0) {
      delete rooms[currentRoom];
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.users)[0];
      io.to(room.hostId).emit('promoted-host');
    }
    io.to(currentRoom).emit('user-list', { users: room.users, hostId: room.hostId });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`sync-watch-party running at http://localhost:${PORT}`));
