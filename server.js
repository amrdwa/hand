const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

// إنشاء ورق اللعب (شدتين هاند = 108 كروت مع الجوكرز)
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  let id = 1;

  for (let d = 0; d < 2; d++) { // شدتين
    for (let s of suits) {
      for (let v of values) {
        let color = (s === '♥' || s === '♦') ? 'red' : 'black';
        deck.push({ id: id++, value: v, suit: s, color: color });
      }
    }
    // إضافة 2 جوكر لكل شدة
    deck.push({ id: id++, value: 'JOKER', suit: '🃏', color: 'red' });
    deck.push({ id: id++, value: 'JOKER', suit: '🃏', color: 'black' });
  }

  // خلط الأوراق
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// حساب قيمة الكرت للنقاط (نظام الـ 51)
function getCardValue(card) {
  if (card.value === 'A') return 11;
  if (['K', 'Q', 'J'].includes(card.value)) return 10;
  if (card.value === 'JOKER') return 15;
  return parseInt(card.value) || 0;
}

io.on('connection', (socket) => {

  // 1. إنشاء غرفة
  socket.on('create-room', ({ name }, cb) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[code] = {
      code: code,
      players: [{ id: socket.id, name, hand: [] }],
      deck: [],
      discardPile: [],
      melds: [],
      turnIndex: 0,
      round: 1,
      started: false,
      hasDrawn: false
    };
    socket.join(code);
    cb({ success: true, code });
  });

  // 2. دخول غرفة
  socket.on('join-room', ({ name, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ success: false, message: 'الغرفة غير موجودة' });
    if (room.players.length >= 4) return cb({ success: false, message: 'الغرفة مكتملة' });

    room.players.push({ id: socket.id, name, hand: [] });
    socket.join(code);
    cb({ success: true });

    io.to(code).emit('update-players', room.players);
  });

  // 3. بدء اللعبة وتوزيع الأوراق
  socket.on('start-game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;

    room.deck = createDeck();
    room.discardPile = [];
    room.melds = [];
    room.started = true;
    room.turnIndex = 0;
    room.hasDrawn = false;

    // توزيع الكروت (14 كرت لكل لاعب، و15 للاعب الأول)
    room.players.forEach((p, index) => {
      const count = index === 0 ? 15 : 14;
      p.hand = room.deck.splice(0, count);
      io.to(p.id).emit('your-hand', p.hand);
    });

    // كرت الساحة الأول
    room.discardPile.push(room.deck.pop());

    sendGameState(code);
  });

  // 4. السحب (من الكوم أو الساحة)
  socket.on('draw-card', ({ roomCode, fromDiscard }) => {
    const room = rooms[roomCode];
    if (!room || room.hasDrawn) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    let drawnCard;
    if (fromDiscard && room.discardPile.length > 0) {
      drawnCard = room.discardPile.pop();
    } else if (room.deck.length > 0) {
      drawnCard = room.deck.pop();
    }

    if (drawnCard) {
      currentPlayer.hand.push(drawnCard);
      room.hasDrawn = true;
      socket.emit('your-hand', currentPlayer.hand);
      sendGameState(roomCode);
    }
  });

  // 5. تنزيل المجموعات (فحص الـ 51 نقطة)
  socket.on('meld-cards', ({ roomCode, cardIds }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const selectedCards = player.hand.filter(c => cardIds.includes(c.id));

    // حساب مجموع نقاط الكروت المحددة
    const totalSum = selectedCards.reduce((sum, card) => sum + getCardValue(card), 0);

    // شرط التنزيل: المجموع يجب أن يكون 51 نقطة على الأقل وبحد أدنى 3 كروت
    if (selectedCards.length >= 3 && totalSum >= 51) {
      // إزالة الكروت من يد اللاعب
      player.hand = player.hand.filter(c => !cardIds.includes(c.id));
      
      // إضافة المجموعة للطاولة
      room.melds.push(selectedCards);

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    } else {
      // إرسال تنبيه الخطأ لمتصفح اللاعب
      socket.emit('error-msg', 'الورقة التي أضفتها خاطئة أو في المكان الخاطئ');
    }
  });

  // 6. رمي كرت في الساحة وإنهاء الدور
  socket.on('discard-card', ({ roomCode, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.hasDrawn) return;

    const player = room.players[room.turnIndex];
    if (player.id !== socket.id) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      const [discarded] = player.hand.splice(cardIndex, 1);
      room.discardPile.push(discarded);

      // الانتقال للاعب التالي
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.hasDrawn = false;

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    }
  });

  socket.on('disconnect', () => {
    // التعامل مع خروج اللاعب
  });
});

function sendGameState(code) {
  const room = rooms[code];
  if (!room) return;

  const currentPlayer = room.players[room.turnIndex];

  io.to(code).emit('game-state', {
    round: room.round,
    deckCount: room.deck.length,
    discardTop: room.discardPile[room.discardPile.length - 1] || null,
    turnPlayerId: currentPlayer ? currentPlayer.id : null,
    turnPlayerName: currentPlayer ? currentPlayer.name : '',
    hasDrawn: room.hasDrawn,
    melds: room.melds
  });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
