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
function getCardScore(card, groupCards = null) {
  const valOrder = {'2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};
  if (card.value === 'A') return 11;
  if (['K', 'Q', 'J'].includes(card.value)) return 10;
  if (card.value !== 'JOKER') return parseInt(card.value) || 0;
  
  // حساب قيمة الجوكر بناءً على مكانه في المجموعة إذا وجد
  if (groupCards) {
    const idx = groupCards.findIndex(c => c.id === card.id);
    let prev = groupCards[idx-1], next = groupCards[idx+1];
    if (prev && prev.value !== 'JOKER') return (valOrder[prev.value] || 0) + 1;
    if (next && next.value !== 'JOKER') return Math.max(1, (valOrder[next.value] || 0) - 1);
  }
  return 10;
}

// التحقق من صحة مجموعة واحدة (مجموعات متشابهة أو تسلسل)
function isValidSingleMeld(sub) {
  const valOrder = {'2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};
  if (sub.length < 3) return false;

  let nonJokers = sub.filter(c => c.value !== 'JOKER');
  
  // 1. فحص المجموعات المتشابهة (Sets: نفس القيمة، أنواع مختلفة)
  if (nonJokers.length > 0) {
    let firstVal = nonJokers[0].value;
    let isSameSet = nonJokers.every(c => c.value === firstVal);
    let suits = new Set(nonJokers.map(c => c.suit));
    if (isSameSet && suits.size === nonJokers.length && sub.length >= 3 && sub.length <= 4) {
      return true;
    }
  }

  // 2. فحص التسلسل (Runs: نفس النوع، أرقام متتالية)
  if (nonJokers.length > 0) {
    let targetSuit = nonJokers[0].suit;
    let sameSuit = nonJokers.every(c => c.suit === targetSuit);
    if (sameSuit) {
      if (isValidRunDirection(sub, valOrder, 1) || isValidRunDirection(sub, valOrder, -1)) {
        return true;
      }
    }
  }

  return false;
}

function isValidRunDirection(sub, valOrder, step) {
  let lastVal = null;
  let lastIdx = -1;

  for (let k = 0; k < sub.length; k++) {
    if (sub[k].value !== 'JOKER') {
      let currentVal = valOrder[sub[k].value];
      if (lastVal !== null) {
        let expectedVal = lastVal + (step * (k - lastIdx));
        if (currentVal !== expectedVal) return false;
      }
      lastVal = currentVal;
      lastIdx = k;
    }
  }
  return true;
}

io.on('connection', (socket) => {

  // 1. إنشاء غرفة
  socket.on('create-room', ({ name }, cb) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[code] = {
      code: code,
      players: [{ id: socket.id, name, hand: [], hasMelded: false }],
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

    room.players.push({ id: socket.id, name, hand: [], hasMelded: false });
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

    room.players.forEach((p, index) => {
      p.hasMelded = false;
      const count = index === 0 ? 15 : 14;
      p.hand = room.deck.splice(0, count);
      io.to(p.id).emit('your-hand', p.hand);
    });

    room.discardPile.push(room.deck.pop());
    sendGameState(code);
  });

  // 4. السحب
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

  // 5. تنزيل المجموعات (التحقق الدقيق لكل مجموعة + شرط 51 نقطة)
  socket.on('meld-cards', ({ roomCode, cardIds }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const selectedCards = player.hand.filter(c => cardIds.includes(c.id));
    if (selectedCards.length === 0) {
      return socket.emit('error-msg', 'الرجاء اختيار كروت صحيحة للنزول');
    }

    // محاولة تقسيم الكروت المحددة إلى مجموعات صحيحة متتالية (نفس منطق الواجهة)
    let parsedMelds = [];
    let remainingCards = [...selectedCards];
    
    // خوارزمية بسيطة لاستخراج المجموعات الصحيحة من الكروت المحددة
    while (remainingCards.length >= 3) {
      let foundMeld = false;
      for (let len = remainingCards.length; len >= 3; len--) {
        let sub = remainingCards.slice(0, len);
        if (isValidSingleMeld(sub)) {
          parsedMelds.push(sub);
          remainingCards = remainingCards.slice(len);
          foundMeld = false;
          break;
        } else {
          // جرب ترتيبات جزئية أو ابحث بطريقة أبسط
          // للتسهيل: نفترض أن اللاعب رتبهم بجانب بعض في يده كما تظهر الملونة في الواجهة
        }
      }
      if (!foundMeld && remainingCards.length === selectedCards.length) {
        // إذا فشل التقسيم التلقائي، جرب اعتبار الكروت المحددة ككل عبارة عن مجموعات مجزأة حسب ترتيب اليد
        break;
      }
      if (foundMeld) break;
    }

    // طريقة بديلة دقيقة: فحص الـ cardIds بناءً على المجموعات الملونة تماماً في الواجهة
    // نقوم بتقسيم الـ selectedCards بناءً على الفواصل الصحيحة للمجموعات
    let verifiedGroups = [];
    let currentGroup = [];
    
    // سنعتمد على ترتيب الكروت تماماً كما أرسلها اللاعب (يجب أن تكون مرتبة في يده بالمجموعات)
    // أو نقوم بفحص مصفوفة الكروت المحددة عبر تقسيمها عند كل مجموعة صحيحة:
    let tempRow = [...player.hand.filter(c => cardIds.includes(c.id))];
    let i = 0;
    let totalScore = 0;
    
    while (i < tempRow.length) {
      let matchedLen = 0;
      for (let len = tempRow.length - i; len >= 3; len--) {
        let sub = tempRow.slice(i, i + len);
        if (isValidSingleMeld(sub)) {
          matchedLen = len;
          break;
        }
      }
      
      if (matchedLen > 0) {
        let subMeld = tempRow.slice(i, i + matchedLen);
        verifiedGroups.push(subMeld);
        let groupSum = subMeld.reduce((s, c) => s + getCardScore(c, subMeld), 0);
        totalScore += groupSum;
        i += matchedLen;
      } else {
        i++; // تجاوز الكرت الخاطئ أو غير المكتمل
      }
    }

    // التحقق من شرط النزول الأول (مجموع النقاط >= 51 و وجود مجموعة واحدة صحيحة على الأقل)
    if (!player.hasMelded && (verifiedGroups.length === 0 || totalScore < 51)) {
      return socket.emit('error-msg', 'مجموع الكروت يجب أن يكون 51 نقطة على الأقل في مجموعات صحيحة');
    }

    if (verifiedGroups.length > 0) {
      let flatCardIdsToRem = verifiedGroups.flat().map(c => c.id);
      
      // إزالة الكروت من يد اللاعب
      player.hand = player.hand.filter(c => !flatCardIdsToRem.includes(c.id));
      player.hasMelded = true;

      // إضافة المجموعات للطاولة
      verifiedGroups.forEach(group => {
        room.melds.push(group);
      });

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    } else {
      socket.emit('error-msg', 'الورقة التي أضفتها خاطئة أو في المكان الخاطئ');
    }
  });

  // 6. رمي كرت وإنهاء الدور
  socket.on('discard-card', ({ roomCode, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.hasDrawn) return;

    const player = room.players[room.turnIndex];
    if (player.id !== socket.id) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      const [discarded] = player.hand.splice(cardIndex, 1);
      room.discardPile.push(discarded);

      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.hasDrawn = false;

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    }
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
