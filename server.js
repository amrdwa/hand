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
      players: [{ id: socket.id, name: name.trim(), hand: [], totalScore: 0, roundScores: [], isMelded: false }],
      round: 1,
      maxRounds: 5,
      started: false,
      deck: [],
      discardPile: [],
      turnIndex: 0,
      hasDrawn: false
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code, isHost: true });
    io.to(code).emit("update-players", room.players);
  });

  socket.on("join-room", ({ name, code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ success: false, message: "الغرفة غير موجودة" });
    if (room.started) return cb({ success: false, message: "اللعبة بدأت" });
    if (room.players.length >= 4) return cb({ success: false, message: "الغرفة ممتلئة" });

    room.players.push({ id: socket.id, name: name.trim(), hand: [], totalScore: 0, roundScores: [], isMelded: false });
    socket.join(code);
    socket.roomCode = code;
    cb({ success: true, code, isHost: false });
    io.to(code).emit("update-players", room.players);
  });

  socket.on("start-game", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return cb({ success: false });
    if (room.players.length < 2) return cb({ success: false, message: "يلزم 2 إلى 4 لاعبين" });

    startRound(room);
    cb({ success: true });
  });

  function startRound(room) {
    room.started = true;
    room.deck = createDeck();
    room.discardPile = [];
    room.turnIndex = 0;
    room.hasDrawn = true; // صاحب الضربة الأولى معاه 15 كرت وما بيسحب

    room.players.forEach((p, index) => {
      p.isMelded = false;
      const count = (index === 0) ? 15 : 14;
      p.hand = room.deck.splice(0, count);
      io.to(p.id).emit("your-hand", p.hand);
    });

    broadcastGameState(room);
  }

  function broadcastGameState(room) {
    io.to(room.code).emit("game-state", {
      round: room.round,
      maxRounds: room.maxRounds,
      turnPlayerId: room.players[room.turnIndex].id,
      turnPlayerName: room.players[room.turnIndex].name,
      discardTop: room.discardPile[room.discardPile.length - 1] || null,
      deckCount: room.deck.length,
      hasDrawn: room.hasDrawn,
      players: room.players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isMelded: p.isMelded, totalScore: p.totalScore }))
    });
  }

  socket.on("draw-card", ({ fromDiscard }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started) return;
    if (room.players[room.turnIndex].id !== socket.id) return;
    if (room.hasDrawn) return;

    let card;
    if (fromDiscard) {
      if (room.discardPile.length === 0) return;
      card = room.discardPile.pop();
    } else {
      if (room.deck.length === 0) return;
      card = room.deck.shift();
    }

    const player = room.players[room.turnIndex];
    player.hand.push(card);
    room.hasDrawn = true;

    socket.emit("your-hand", player.hand);
    broadcastGameState(room);
  });

  socket.on("discard-card", ({ cardId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started) return;
    const playerIndex = room.turnIndex;
    const player = room.players[playerIndex];
    if (player.id !== socket.id || !room.hasDrawn) return;

    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const [discardedCard] = player.hand.splice(cardIdx, 1);
    room.discardPile.push(discardedCard);

    // التحقق من إنهاء الجولة (فوز عادي)
    if (player.hand.length === 0) {
      finishRound(room, player, false);
      return;
    }

    // الانتقال للاعب التالي
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    room.hasDrawn = false;

    socket.emit("your-hand", player.hand);
    broadcastGameState(room);
  });

  socket.on("declare-hand-win", () => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.started) return;
    const player = room.players[room.turnIndex];
    if (player.id !== socket.id) return;

    finishRound(room, player, true);
  });

  function finishRound(room, winner, isHandWin) {
    room.players.forEach(p => {
      let score = 0;
      if (p.id === winner.id) {
        score = isHandWin ? -60 : -30; // نقاط جواكر للفائز
      } else {
        if (!p.isMelded) {
          score = isHandWin ? 200 : 100; // عقوبة عدم التنزيل
        } else {
          // حساب مجموع أوراق اليد النازلة
          score = p.hand.reduce((sum, c) => {
            if (c.value === "JOKER") return sum + 25;
            if (c.value === "A") return sum + 10;
            if (["J", "Q", "K"].includes(c.value)) return sum + 10;
            return sum + (parseInt(c.value) || 0);
          }, 0);
        }
      }
      p.roundScores.push(score);
      p.totalScore += score;
    });

    io.to(room.code).emit("round-ended", {
      winnerName: winner.name,
      isHandWin,
      players: room.players
    });

    if (room.round >= room.maxRounds) {
      io.to(room.code).emit("game-over", room.players);
    } else {
      room.round++;
    }
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
