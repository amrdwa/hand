const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000 });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const values = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  let deck = [];

  for (let d = 0; d < 2; d++) {
    for (let s of suits) {
      for (let v of values) {
        let color = (s === "♥" || s === "♦") ? "red" : "black";
        deck.push({ suit: s, value: v, color, id: Math.random().toString(36).substr(2, 9) });
      }
    }
    deck.push({ suit: "🃏", value: "JOKER", color: "red", id: Math.random().toString(36).substr(2, 9) });
    deck.push({ suit: "🃏", value: "JOKER", color: "black", id: Math.random().toString(36).substr(2, 9) });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name }, cb) => {
    if (!name) return cb({ success: false, message: "ادخل الاسم" });
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const room = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: name.trim(), hand: [], totalScore: 0, roundScores: [] }],
      round: 1,
      started: false,
      deck: [],
      discardPile: [],
      turnIndex: 0
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code });
    io.to(code).emit("update-players", room.players);
  });

  socket.on("join-room", ({ name, code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ success: false, message: "الغرفة غير موجودة" });
    if (room.started) return cb({ success: false, message: "اللعبة بدأت" });
    if (room.players.length >= 4) return cb({ success: false, message: "الغرفة ممتلئة" });

    room.players.push({ id: socket.id, name: name.trim(), hand: [], totalScore: 0, roundScores: [] });
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code });
    io.to(code).emit("update-players", room.players);
  });

  socket.on("start-game", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return cb({ success: false });
    if (room.players.length < 2) return cb({ success: false, message: "يلزم لاعبين على الأقل (2-4)" });

    room.started = true;
    room.deck = createDeck();
    room.players.forEach((p, index) => {
      const count = (index === 0) ? 15 : 14;
      p.hand = room.deck.splice(0, count);
      io.to(p.id).emit("your-hand", p.hand);
    });

    io.to(room.code).emit("round-started", {
      round: room.round,
      turnPlayerId: room.players[0].id
    });
    cb({ success: true });
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
