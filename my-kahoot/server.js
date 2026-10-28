const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { listQuestions, createQuestion } = require('./database');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const rooms = new Map();
const sockets = new Map();

function safeName(value) {
  return String(value || '').trim().slice(0, 18);
}

function createCode() {
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    players: [...room.players.values()].map(({ id, name, score }) => ({ id, name, score }))
  };
}

function send(socket, type, payload = {}) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

function broadcast(room, type, payload = {}) {
  for (const player of room.players.values()) send(sockets.get(player.id), type, payload);
}

function broadcastRoom(room) {
  broadcast(room, 'room:update', { room: roomSnapshot(room) });
}

function publicQuestion(room) {
  const question = room.questions[room.questionIndex];
  return { index: room.questionIndex, total: room.questions.length, prompt: question.description, options: question.alternatives, type: question.type };
}

function reveal(room) {
  if (room.status !== 'question') return;
  room.status = 'results';
  const question = room.questions[room.questionIndex];
  broadcast(room, 'question:results', {
    correctAnswer: question.answer,
    scores: roomSnapshot(room).players.sort((a, b) => b.score - a.score)
  });
  broadcastRoom(room);
  room.nextTimer = setTimeout(() => nextQuestion(room), 3500);
}

function nextQuestion(room) {
  if (!rooms.has(room.code)) return;
  if (room.questionIndex >= room.questions.length - 1) {
    room.status = 'finished';
    broadcast(room, 'game:finished', { scores: roomSnapshot(room).players.sort((a, b) => b.score - a.score) });
    broadcastRoom(room);
    return;
  }
  room.questionIndex += 1;
  room.status = 'question';
  room.answered.clear();
  broadcast(room, 'question:new', { question: publicQuestion(room), duration: 8 });
  broadcastRoom(room);
  room.revealTimer = setTimeout(() => reveal(room), 8000);
}

function removePlayer(id) {
  const current = sockets.get(id);
  if (!current || !current.roomCode) return;
  const room = rooms.get(current.roomCode);
  if (!room) return;
  room.players.delete(id);
  if (room.hostId === id) {
    room.hostId = room.players.keys().next().value || null;
    if (!room.hostId) rooms.delete(room.code);
  }
  sockets.delete(id);
  if (rooms.has(room.code)) broadcastRoom(room);
}

async function handleMessage(socket, message) {
  let data;
  try { data = JSON.parse(message); } catch { return send(socket, 'error', { message: 'Mensagem inválida.' }); }

  if (data.type === 'questions:list') {
    return send(socket, 'questions:list', { questions: await listQuestions() });
  }

  if (data.type === 'question:create') {
    const description = String(data.description || '').trim().slice(0, 180);
    const type = data.typeValue === 'true_false' ? 'true_false' : 'multiple_choice';
    const alternatives = Array.isArray(data.alternatives) ? data.alternatives.map(value => String(value).trim().slice(0, 80)).filter(Boolean) : [];
    const correctAlternative = Number(data.correctAlternative);
    const expectedAlternatives = type === 'true_false' ? 2 : 4;
    if (!description || alternatives.length !== expectedAlternatives || !Number.isInteger(correctAlternative) || correctAlternative < 0 || correctAlternative >= alternatives.length) {
      return send(socket, 'error', { message: type === 'true_false' ? 'Preencha a afirmação e escolha a resposta correta.' : 'Preencha a pergunta, as quatro alternativas e a resposta correta.' });
    }
    const question = await createQuestion({ description, alternatives, correctAlternative, type });
    return send(socket, 'question:created', { question });
  }

  if (data.type === 'room:create' || data.type === 'room:join') {
    const name = safeName(data.name);
    if (!name) return send(socket, 'error', { message: 'Digite seu nome para entrar.' });
    if (socket.roomCode) removePlayer(socket.id);
    let room;
    if (data.type === 'room:create') {
      room = { code: createCode(), hostId: socket.id, status: 'lobby', questionIndex: 0, questions: await listQuestions(), players: new Map(), answered: new Set() };
      rooms.set(room.code, room);
    } else {
      const code = String(data.code || '').trim().toUpperCase();
      room = rooms.get(code);
      if (!room) return send(socket, 'error', { message: 'Sala não encontrada. Confira o código.' });
      if (room.status !== 'lobby') return send(socket, 'error', { message: 'Essa partida já começou.' });
    }
    room.players.set(socket.id, { id: socket.id, name, score: 0 });
    socket.roomCode = room.code;
    send(socket, 'room:joined', { room: roomSnapshot(room), selfId: socket.id });
    broadcastRoom(room);
    return;
  }

  const room = socket.roomCode && rooms.get(socket.roomCode);
  if (!room) return send(socket, 'error', { message: 'Entre em uma sala primeiro.' });

  if (data.type === 'game:start') {
    if (room.hostId !== socket.id) return;
    room.status = 'question';
    room.questionIndex = 0;
    broadcast(room, 'question:new', { question: publicQuestion(room), duration: 8 });
    broadcastRoom(room);
    room.revealTimer = setTimeout(() => reveal(room), 8000);
  }

  if (data.type === 'question:answer') {
    if (room.status !== 'question' || room.answered.has(socket.id)) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.answered.add(socket.id);
    const question = room.questions[room.questionIndex];
    if (Number(data.answer) === question.answer) player.score += 100;
    send(socket, 'answer:received', { correct: Number(data.answer) === question.answer });
    broadcastRoom(room);
    if (room.answered.size === room.players.size) {
      clearTimeout(room.revealTimer);
      reveal(room);
    }
  }
}

const server = http.createServer((req, res) => {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return res.writeHead(403).end();
  fs.readFile(filePath, (error, content) => {
    if (error) return res.writeHead(404).end('Not found');
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (socket) => {
  socket.id = crypto.randomUUID();
  sockets.set(socket.id, socket);
  send(socket, 'connected', { id: socket.id });
  socket.on('message', (message) => handleMessage(socket, message.toString()));
  socket.on('close', () => removePlayer(socket.id));
});

server.listen(PORT, () => console.log(`PulsePlay rodando em http://localhost:${PORT}`));
