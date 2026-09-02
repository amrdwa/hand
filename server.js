const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

let rooms = {};

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  let deck = [];
  let id = 1;

  for (let d = 0; d < 2; d++) {
    for (let s of suits) {
      for (let v of values) {
        deck.push({ id: id++, suit: s, value: v, color: (s === "♥" || s === "♦") ? "red" : "black" });
      }
    }
  }
  deck.push({ id: id++, suit: "🃏", value: "JOKER", color: "red" });
  deck.push({ id: id++, suit: "🃏", value: "JOKER", color: "black" });

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name }, callback) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[code] = {
      code,
      creatorId: socket.id,
      players: [{ id: socket.id, name, hand: [], score: 0 }],
      status: "waiting",
      deck: [],
      discardPile: [],
      turnIndex: 0,
      round: 1,
      hasDrawn: false
    };
    socket.join(code);
    callback({ success: true, code });
    io.to(code).emit("update-players", rooms[code].players);
  });

  socket.on("join-room", ({ name, code }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ success: false, message: "الغرفة غير موجودة" });
    if (room.players.length >= 4) return callback({ success: false, message: "الغرفة مكتملة (4 لاعبين)" });
    if (room.status !== "waiting") return callback({ success: false, message: "اللعبة بدأت بالفعل" });

    room.players.push({ id: socket.id, name, hand: [], score: 0 });
    socket.join(code);
    callback({ success: true });

    io.to(code).emit("update-players", room.players);
  });

  socket.on("start-game", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.creatorId !== socket.id) return;
    if (room.players.length < 2) return;

    room.status = "playing";
    room.deck = createDeck();
    room.discardPile = [];
    room.turnIndex = 0;
    room.hasDrawn = false;

    room.players.forEach(p => {
      p.hand = room.deck.splice(0, 14);
      io.to(p.id).emit("your-hand", p.hand);
    });

    sendGameState(code);
  });

  socket.on("draw-card", ({ fromDiscard }) => {
    let room = findUserRoom(socket.id);
    if (!room || room.status !== "playing") return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id || room.hasDrawn) return;

    let drawnCard = null;
    if (fromDiscard && room.discardPile.length > 0) {
      drawnCard = room.discardPile.pop();
    } else if (room.deck.length > 0) {
      drawnCard = room.deck.pop();
    }

    if (drawnCard) {
      currentPlayer.hand.push(drawnCard);
      room.hasDrawn = true;
      socket.emit("your-hand", currentPlayer.hand);
      sendGameState(room.code);
    }
  });

  socket.on("discard-card", ({ cardId }) => {
    let room = findUserRoom(socket.id);
    if (!room || room.status !== "playing") return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id || !room.hasDrawn) return;

    const cardIndex = currentPlayer.hand.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      const card = currentPlayer.hand.splice(cardIndex, 1)[0];
      room.discardPile.push(card);
      room.hasDrawn = false;
      room.turnIndex = (room.turnIndex + 1) % room.players.length;

      socket.emit("your-hand", currentPlayer.hand);
      sendGameState(room.code);
    }
  });

  socket.on("disconnect", () => {
    let room = findUserRoom(socket.id);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[room.code];
      } else {
        io.to(room.code).emit("update-players", room.players);
      }
    }
  });
});

function findUserRoom(socketId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === socketId));
}

function sendGameState(code) {
  const room = rooms[code];
  if (!room) return;

  const currentPlayer = room.players[room.turnIndex];
  io.to(code).emit("game-state", {
    round: room.round,
    deckCount: room.deck.length,
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    turnPlayerId: currentPlayer.id,
    turnPlayerName: currentPlayer.name,
    hasDrawn: room.hasDrawn
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
