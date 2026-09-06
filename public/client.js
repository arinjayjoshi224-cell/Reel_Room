import WebTorrent from 'https://esm.sh/webtorrent';

const socket = io();

const $ = (id) => document.getElementById(id);

// ---------- Landing page background music ----------
const bgMusic = $('bg-music');
const musicToggle = $('music-toggle');
bgMusic.volume = 0.35;

function tryPlayMusic() {
  // Autoplay with sound is blocked by browsers, so start muted (always
  // allowed) and reveal a toggle for the person to turn sound on.
  bgMusic.muted = true;
  bgMusic.play().then(() => {
    musicToggle.classList.remove('hidden');
    musicToggle.textContent = '🔇';
  }).catch(() => {
    // Even muted autoplay was blocked — wait for any click on the page.
    musicToggle.classList.remove('hidden');
    musicToggle.textContent = '🔇';
    document.body.addEventListener('click', () => bgMusic.play().catch(() => {}), { once: true });
  });
}
tryPlayMusic();

musicToggle.addEventListener('click', () => {
  bgMusic.muted = !bgMusic.muted;
  musicToggle.textContent = bgMusic.muted ? '🔇' : '🔊';
  if (!bgMusic.muted) bgMusic.play().catch(() => {});
});

function stopLandingMusic() {
  bgMusic.pause();
  bgMusic.currentTime = 0;
  musicToggle.classList.add('hidden');
}

// ---------- Landing ----------
const landing = $('landing');
const roomScreen = $('room');
const landingError = $('landing-error');

$('btn-create').addEventListener('click', () => {
  const name = $('create-name').value.trim() || 'Host';
  myName = name;
  socket.emit('create-room', { name });
});

$('btn-join').addEventListener('click', () => {
  const roomId = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim() || 'Guest';
  myName = name;
  if (!roomId) { landingError.textContent = 'Enter a room code first.'; return; }
  socket.emit('join-room', { roomId, name });
});

socket.on('error-message', (msg) => { landingError.textContent = msg; });

// ---------- Room state ----------
let roomId = null;
let isHost = false;
let selfId = null;
let myName = null;
let applyingRemote = false; // guards against echoing our own remote-applied actions
const player = $('player');

function enterRoom({ roomId: id, isHost: host, selfId: sid, state, fileName, torrents }) {
  roomId = id; isHost = host; selfId = sid;
  stopLandingMusic();
  landing.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  $('room-code').textContent = roomId;
  if (fileName) $('active-filename').textContent = `${fileName} (load your own copy)`;
  if (state) {
    player.currentTime = state.time || 0;
  }
  if (torrents && torrents.length) renderTorrentList(torrents);
}

socket.on('room-created', (data) => enterRoom(data));
socket.on('room-joined', (data) => enterRoom(data));

socket.on('promoted-host', () => {
  isHost = true;
  addSystemMsg('You are now the host.');
});

socket.on('user-list', ({ users, hostId }) => {
  const list = $('user-list');
  list.innerHTML = '';
  Object.entries(users).forEach(([id, name]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="seat-dot"></span>${name}${id === hostId ? '<span class="host-tag">HOST</span>' : ''}`;
    list.appendChild(li);
  });
});

socket.on('system-message', (msg) => addSystemMsg(msg));

socket.on('host-filename', (fileName) => {
  $('active-filename').textContent = `${fileName} — load the same file from your computer`;
});

$('copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomId);
  $('copy-code').textContent = 'copied';
  setTimeout(() => $('copy-code').textContent = 'copy', 1200);
});

// ---------- Local file loading ----------
let loadedFile = null;

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadedFile = file;
  const url = URL.createObjectURL(file);
  player.src = url;
  $('active-filename').textContent = file.name;
  socket.emit('set-filename', { fileName: file.name });
  $('btn-share-p2p').disabled = false;
});

// ---------- P2P sharing via WebTorrent (WebRTC) ----------
// The video never touches our server here — only magnet URIs (short text
// strings) are relayed over the socket so peers can find each other.
// Anyone can seed, including multiple people seeding the same file —
// identical files hash to the same magnet URI, so WebTorrent automatically
// pools everyone seeding it into one swarm.
const torrentClient = new WebTorrent();
const mySeedingMagnets = new Set();

$('btn-share-p2p').addEventListener('click', () => {
  if (!loadedFile) return;
  $('btn-share-p2p').disabled = true;
  $('btn-share-p2p').textContent = 'Seeding…';
  torrentClient.seed(loadedFile, (torrent) => {
    mySeedingMagnets.add(torrent.magnetURI);
    $('btn-share-p2p').textContent = 'Share via P2P';
    $('btn-share-p2p').disabled = false; // free to load & share another file too
    socket.emit('torrent-offer', { magnetURI: torrent.magnetURI, fileName: loadedFile.name });
  });
});

socket.on('torrent-list', (list) => renderTorrentList(list));

function renderTorrentList(list) {
  const wrap = $('torrent-list-wrap');
  const ul = $('torrent-list');
  if (!list.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  ul.innerHTML = '';
  list.forEach(({ magnetURI, fileName, seeders }) => {
    const li = document.createElement('li');
    li.className = 'torrent-item';
    const amSeeder = mySeedingMagnets.has(magnetURI) || (seeders || []).includes(myName);
    li.innerHTML = `
      <div class="torrent-item-info">
        <span class="torrent-item-name">${escapeHtml(fileName)}</span>
        <span class="torrent-item-seeders">${(seeders || []).length} seeder(s): ${escapeHtml((seeders || []).join(', '))}</span>
      </div>
      ${amSeeder ? '<span class="seeding-badge">SEEDING</span>' : '<button class="btn btn-amber">Download &amp; watch</button>'}
    `;
    if (!amSeeder) {
      li.querySelector('button').addEventListener('click', () => downloadTorrent(magnetURI, fileName));
    }
    ul.appendChild(li);
  });
}

function downloadTorrent(magnetURI, fileName) {
  const progressBox = $('torrent-progress');
  progressBox.classList.remove('hidden');

  torrentClient.add(magnetURI, (torrent) => {
    const file = torrent.files.find((f) => /\.(mp4|mov|webm|mkv)$/i.test(f.name)) || torrent.files[0];

    // Stream straight into the <video> element as pieces arrive.
    file.streamTo(player);
    $('active-filename').textContent = `${fileName} (via P2P)`;
    loadedFile = null;

    const interval = setInterval(() => {
      const pct = Math.round(torrent.progress * 100);
      $('torrent-progress-fill').style.width = pct + '%';
      $('torrent-progress-text').textContent = pct >= 100
        ? 'download complete — now seeding'
        : `${pct}% — ${(torrent.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s, ${torrent.numPeers} peer(s)`;
      if (pct >= 100) clearInterval(interval);
    }, 500);

    // WebTorrent keeps seeding what you've downloaded by default —
    // announce that so everyone's list reflects you as another seeder.
    torrent.on('done', () => {
      mySeedingMagnets.add(magnetURI);
      socket.emit('torrent-offer', { magnetURI, fileName });
      setTimeout(() => progressBox.classList.add('hidden'), 2000);
    });
  });
}

// ---------- Outgoing playback events ----------
player.addEventListener('play', () => {
  if (applyingRemote) return;
  socket.emit('playback-event', { type: 'play', time: player.currentTime });
});
player.addEventListener('pause', () => {
  if (applyingRemote) return;
  socket.emit('playback-event', { type: 'pause', time: player.currentTime });
});
player.addEventListener('seeked', () => {
  if (applyingRemote) return;
  socket.emit('playback-event', { type: 'seek', time: player.currentTime });
});

// periodic drift ping so late-joiners / clocks that wandered get corrected
setInterval(() => {
  if (!roomId || player.paused || !player.duration) return;
  socket.emit('sync-time', { time: player.currentTime });
}, 4000);

// ---------- Incoming playback events ----------
function withRemoteGuard(fn) {
  applyingRemote = true;
  fn();
  setTimeout(() => { applyingRemote = false; }, 300);
}

socket.on('playback-event', (data) => {
  flashDrift(false);
  withRemoteGuard(() => {
    if (Math.abs(player.currentTime - data.time) > 0.35) player.currentTime = data.time;
    if (data.type === 'play') player.play().catch(() => {});
    if (data.type === 'pause') player.pause();
  });
});

socket.on('sync-time', ({ time }) => {
  const drift = Math.abs(player.currentTime - time);
  if (drift > 1) {
    flashDrift(true);
    withRemoteGuard(() => { player.currentTime = time; });
    setTimeout(() => flashDrift(false), 900);
  }
});

function flashDrift(on) {
  $('sync-dot').classList.toggle('drift', on);
  $('sync-text').textContent = on ? 'correcting drift…' : 'in sync';
}

// ---------- Chat ----------
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat-message', msg);
  input.value = '';
});

socket.on('chat-message', ({ name, msg }) => {
  const log = $('chat-log');
  const li = document.createElement('li');
  li.innerHTML = `<span class="who">${escapeHtml(name)}:</span>${escapeHtml(msg)}`;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
});

function addSystemMsg(text) {
  const log = $('chat-log');
  const li = document.createElement('li');
  li.className = 'system';
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
