const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data.json');
const AVATAR_COLORS = ['#00a884', '#128c7e', '#075e54', '#2563eb', '#7c3aed', '#db2777', '#ea580c'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.redirect('/admin.html'));

// Load or initialize database file
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading data.json, creating fresh data.');
    }
  }
  return {
    settings: {
      appName: 'My Chat',
      tagline: 'Fast, Simple & Private Messaging',
      announcement: 'Welcome to My Chat! Respect everyone in the chat.',
      themeColor: '#00a884',
      allowSignups: true
    },
    users: [],
    messages: [],
    sessions: {}
  };
}

let data = loadData();
const adminTokens = new Set();
const userSockets = new Map(); // phone -> Set(socket.id)

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[\s\-()]/g, '').trim();
}

function getSafeUsers() {
  return data.users.map((u) => ({
    phone: u.phone,
    name: u.name,
    about: u.about || 'Hey there! I am using My Chat.',
    avatarColor: u.avatarColor,
    blocked: Boolean(u.blocked),
    online: userSockets.has(u.phone) && userSockets.get(u.phone).size > 0,
    createdAt: u.createdAt
  }));
}

function getUserMessages(phone) {
  return data.messages.filter(
    (m) => m.roomId === 'global' || m.fromPhone === phone || m.toPhone === phone
  );
}

function emitToUser(phone, event, payload) {
  const sockets = userSockets.get(phone);
  if (!sockets) return;
  sockets.forEach((sid) => io.to(sid).emit(event, payload));
}

// --- USER AUTH API ---
app.post('/api/register', (req, res) => {
  if (!data.settings.allowSignups) {
    return res.status(403).json({ error: 'New signups are currently paused by Admin.' });
  }
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 25);
  const pin = String(req.body.pin || '').trim();

  if (phone.length < 6) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits (e.g. 1234).' });
  }
  if (data.users.some((u) => u.phone === phone)) {
    return res.status(400).json({ error: 'This phone number is already registered. Please Login.' });
  }

  const newUser = {
    phone,
    name,
    pinHash: hashPin(pin),
    about: 'Hey there! I am using My Chat.',
    avatarColor: AVATAR_COLORS[data.users.length % AVATAR_COLORS.length],
    blocked: false,
    createdAt: new Date().toISOString()
  };

  data.users.push(newUser);
  const token = crypto.randomBytes(24).toString('hex');
  data.sessions[token] = phone;
  saveData();

  io.emit('users_updated', getSafeUsers());
  res.json({
    token,
    user: { phone: newUser.phone, name: newUser.name, about: newUser.about, avatarColor: newUser.avatarColor },
    settings: data.settings
  });
});

app.post('/api/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '').trim();

  const user = data.users.find((u) => u.phone === phone);
  if (!user || user.pinHash !== hashPin(pin)) {
    return res.status(401).json({ error: 'Invalid phone number or 4-digit PIN.' });
  }
  if (user.blocked) {
    return res.status(403).json({ error: 'Your account has been blocked by Admin.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  data.sessions[token] = phone;
  saveData();

  res.json({
    token,
    user: { phone: user.phone, name: user.name, about: user.about, avatarColor: user.avatarColor },
    settings: data.settings
  });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token && data.sessions[token]) {
    delete data.sessions[token];
    saveData();
  }
  res.json({ ok: true });
});

// --- ADMIN API ---
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong Admin Password!' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ adminToken: token });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const users = getSafeUsers();
  res.json({
    settings: data.settings,
    users,
    stats: {
      totalUsers: users.length,
      onlineCount: users.filter((u) => u.online).length,
      totalMessages: data.messages.length
    },
    recentMessages: data.messages.slice(-30).reverse()
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { appName, tagline, announcement, themeColor, allowSignups } = req.body;
  if (appName) data.settings.appName = String(appName).trim().slice(0, 30);
  if (tagline !== undefined) data.settings.tagline = String(tagline).trim().slice(0, 80);
  if (announcement !== undefined) data.settings.announcement = String(announcement).trim().slice(0, 150);
  if (themeColor) data.settings.themeColor = String(themeColor).trim();
  if (allowSignups !== undefined) data.settings.allowSignups = Boolean(allowSignups);

  saveData();
  io.emit('settings_updated', data.settings);
  res.json({ ok: true, settings: data.settings });
});

app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message cannot be empty.' });

  const msg = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    roomId: 'global',
    fromPhone: 'ADMIN',
    fromName: `${data.settings.appName} Admin`,
    toPhone: 'global',
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(),
    isAdmin: true
  };

  data.messages.push(msg);
  saveData();
  io.emit('new_message', msg);
  res.json({ ok: true, msg });
});

app.post('/api/admin/users/:phone/toggle-block', requireAdmin, (req, res) => {
  const user = data.users.find((u) => u.phone === req.params.phone);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.blocked = !user.blocked;
  if (user.blocked) {
    Object.keys(data.sessions).forEach((t) => {
      if (data.sessions[t] === user.phone) delete data.sessions[t];
    });
    emitToUser(user.phone, 'force_logout', 'Your account was blocked by Admin.');
  }
  saveData();
  io.emit('users_updated', getSafeUsers());
  res.json({ ok: true, blocked: user.blocked });
});

app.delete('/api/admin/users/:phone', requireAdmin, (req, res) => {
  const phone = req.params.phone;
  data.users = data.users.filter((u) => u.phone !== phone);
  Object.keys(data.sessions).forEach((t) => {
    if (data.sessions[t] === phone) delete data.sessions[t];
  });
  emitToUser(phone, 'force_logout', 'Your account was removed by Admin.');
  saveData();
  io.emit('users_updated', getSafeUsers());
  res.json({ ok: true });
});

app.post('/api/admin/clear-global', requireAdmin, (req, res) => {
  data.messages = data.messages.filter((m) => m.roomId !== 'global');
  saveData();
  io.emit('chat_cleared', 'global');
  res.json({ ok: true });
});

app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  data.messages = data.messages.filter((m) => m.id !== req.params.id);
  saveData();
  io.emit('message_deleted', req.params.id);
  res.json({ ok: true });
});

// --- REAL-TIME SOCKET.IO ---
io.on('connection', (socket) => {
  const token = socket.handshake.auth?.token;
  const phone = token ? data.sessions[token] : null;
  const user = phone ? data.users.find((u) => u.phone === phone) : null;

  if (!user || user.blocked) {
    socket.emit('force_logout', 'Session expired or blocked. Please login again.');
    return socket.disconnect();
  }

  if (!userSockets.has(phone)) userSockets.set(phone, new Set());
  userSockets.get(phone).add(socket.id);

  socket.emit('init_data', {
    me: { phone: user.phone, name: user.name, about: user.about, avatarColor: user.avatarColor },
    settings: data.settings,
    users: getSafeUsers(),
    messages: getUserMessages(phone)
  });

  io.emit('users_updated', getSafeUsers());

  socket.on('send_message', ({ toPhone, text }) => {
    const cleanText = String(text || '').trim().slice(0, 2000);
    if (!cleanText || !toPhone) return;

    const currentUser = data.users.find((u) => u.phone === phone);
    if (!currentUser || currentUser.blocked) return;

    const roomId = toPhone === 'global' ? 'global' : [phone, toPhone].sort().join('_');
    const msg = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`,
      roomId,
      fromPhone: phone,
      fromName: currentUser.name,
      toPhone,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };

    data.messages.push(msg);
    if (data.messages.length > 2000) data.messages = data.messages.slice(-2000);
    saveData();

    if (roomId === 'global') {
      io.emit('new_message', msg);
    } else {
      emitToUser(phone, 'new_message', msg);
      if (toPhone !== phone) emitToUser(toPhone, 'new_message', msg);
    }
  });

  socket.on('typing', ({ toPhone, isTyping }) => {
    const payload = { fromPhone: phone, toPhone, isTyping: Boolean(isTyping) };
    if (toPhone === 'global') {
      socket.broadcast.emit('typing', payload);
    } else {
      emitToUser(toPhone, 'typing', payload);
    }
  });

  socket.on('update_profile', ({ name, about }) => {
    const currentUser = data.users.find((u) => u.phone === phone);
    if (!currentUser) return;
    if (name && String(name).trim()) currentUser.name = String(name).trim().slice(0, 25);
    if (about !== undefined) currentUser.about = String(about).trim().slice(0, 60);
    saveData();
    io.emit('users_updated', getSafeUsers());
  });

  socket.on('disconnect', () => {
    const set = userSockets.get(phone);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSockets.delete(phone);
    }
    io.emit('users_updated', getSafeUsers());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`My Chat is running on http://localhost:${PORT}`);
  console.log(`Admin Panel is on http://localhost:${PORT}/admin`);
});