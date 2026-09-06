const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  let id = 1;

  for (let d = 0; d < 2; d++) {
    for (let s of suits) {
      for (let v of values) {
        let color = (s === '♥' || s === '♦') ? 'red' : 'black';
        deck.push({ id: id++, value: v, suit: s, color: color });
      }
    }
    deck.push({ id: id++, value: 'JOKER', suit: '🃏', color: 'red' });
    deck.push({ id: id++, value: 'JOKER', suit: '🃏', color: 'black' });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCardScore(card, groupCards = null) {
  const valOrder = {'2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};
  if (card.value === 'A') return 11;
  if (['K', 'Q', 'J'].includes(card.value)) return 10;
  if (card.value !== 'JOKER') return parseInt(card.value) || 0;
  
  if (groupCards) {
    const idx = groupCards.findIndex(c => c.id === card.id);
    let prev = groupCards[idx-1], next = groupCards[idx+1];
    if (prev && prev.value !== 'JOKER') return (valOrder[prev.value] || 0) + 1;
    if (next && next.value !== 'JOKER') return Math.max(1, (valOrder[next.value] || 0) - 1);
  }
  return 10;
}

function isValidSingleMeld(sub) {
  const valOrder = {'2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14};
  if (sub.length < 3) return false;

  let nonJokers = sub.filter(c => c.value !== 'JOKER');
  
  // Sets (متشابهة)
  if (nonJokers.length > 0) {
    let firstVal = nonJokers[0].value;
    let isSameSet = nonJokers.every(c => c.value === firstVal);
    let suits = new Set(nonJokers.map(c => c.suit));
    if (isSameSet && suits.size === nonJokers.length && sub.length >= 3 && sub.length <= 4) {
      return true;
    }
  }

  // Runs (متسلسلة)
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

  // دعم إنشاء الغرفة بكلا الحدثين لضمان عمل الواجهة الأمامية بدون أخطاء
  socket.on('create-room', ({ name }, cb) => handleCreateRoom(socket, name, cb));
  socket.on('create_room', ({ name }, cb) => handleCreateRoom(socket, name, cb));

  socket.on('join-room', ({ name, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ success: false, message: 'الغرفة غير موجودة' });
    if (room.players.length >= 4) return cb({ success: false, message: 'الغرفة مكتملة' });
    if (room.started) return cb({ success: false, message: 'اللعبة قد بدأت بالفعل' });

    room.players.push({ id: socket.id, name, hand: [], hasMelded: false, score: 0 });
    socket.join(code);
    cb({ success: true });
    io.to(code).emit('update-players', room.players);
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;

    room.deck = createDeck();
    room.discardPile = [];
    room.melds = [];
    room.started = true;
    room.turnIndex = 0;
    room.hasDrawn = false;
    room.lastActionWasDiscardFromBurn = false; // قاعدة 13: تتبع السحب من المحرقة

    room.players.forEach((p, index) => {
      p.hasMelded = false;
      p.melds = [];
      // قاعدة 1 و 2: الموزع (أول لاعب) يأخذ 15 ورقة والباقي 14 ورقة
      const count = index === 0 ? 15 : 14;
      p.hand = room.deck.splice(0, count);
      io.to(p.id).emit('your-hand', p.hand);
    });

    room.discardPile.push(room.deck.pop());
    sendGameState(code);
  });

  socket.on('draw-card', ({ roomCode, fromDiscard }) => {
    const room = rooms[roomCode];
    if (!room || room.hasDrawn) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    let drawnCard;
    if (fromDiscard && room.discardPile.length > 0) {
      drawnCard = room.discardPile.pop();
      room.lastActionWasDiscardFromBurn = true; // تطبيق قاعدة السحب من الحرق
    } else if (room.deck.length > 0) {
      // قاعدة 14: إعادة تدوير الكوتشينة عند نفادها
      if (room.deck.length === 0) {
        let topBurn = room.discardPile.pop();
        room.deck = createDeck();
        room.discardPile = [topBurn];
      }
      drawnCard = room.deck.pop();
      room.lastActionWasDiscardFromBurn = false;
    }

    if (drawnCard) {
      currentPlayer.hand.push(drawnCard);
      room.hasDrawn = true;
      socket.emit('your-hand', currentPlayer.hand);
      sendGameState(roomCode);
    }
  });

  // معالجة النزول وفحص المجموعات وقاعدة الـ 51 نقطة والجوكر (القواعد 3، 4، 5، 6، 7)
  socket.on('meld-cards', ({ roomCode, cardIds }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    let handCards = [...player.hand];
    let selectedSet = new Set(cardIds);
    let verifiedGroups = [];
    let totalScore = 0;

    let i = 0;
    while (i < handCards.length) {
      if (selectedSet.has(handCards[i].id)) {
        let bestLen = 0;
        for (let len = handCards.length - i; len >= 3; len--) {
          let candidate = handCards.slice(i, i + len);
          let allSelected = candidate.every(c => selectedSet.has(c.id));
          if (allSelected && isValidSingleMeld(candidate)) {
            bestLen = len;
            break;
          }
        }
        if (bestLen > 0) {
          let validMeld = handCards.slice(i, i + bestLen);
          verifiedGroups.push(validMeld);
          totalScore += validMeld.reduce((s, c) => s + getCardScore(c, validMeld), 0);
          i += bestLen;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // قاعدة 3: النزول الأول يجب ألا يقل عن 51 نقطة
    if (!player.hasMelded && (verifiedGroups.length === 0 || totalScore < 51)) {
      return socket.emit('error-msg', `مجموع الكروت المحددة هو ${totalScore} ولا يفي بشرط الـ 51 نقطة للنزول الأول!`);
    }

    if (verifiedGroups.length > 0) {
      let cardsToRemove = verifiedGroups.flat().map(c => c.id);
      
      player.hand = player.hand.filter(c => !cardsToRemove.includes(c.id));
      player.hasMelded = true;
      room.lastActionWasDiscardFromBurn = false; // قاعدة 13: النزول يلغي القيد المفروض على ورقة الحرق

      verifiedGroups.forEach(group => {
        room.melds.push(group);
      });

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    } else {
      socket.emit('error-msg', 'الورقة التي أضفتها خاطئة أو غير مرتبة في مجموعة صحيحة');
    }
  });

  // قاعدة 8: إضافة أوراق إلى مجموعات موجودة مسبقاً على الطاولة
  socket.on('add-to-meld', ({ roomCode, targetPlayerId, meldIndex, cardId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.hasMelded) {
      return socket.emit('error-msg', 'يجب أن تنزل أولاً قبل الإضافة على المجموعات!');
    }

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const cardToAdd = player.hand[cardIndex];
    const currentMeld = room.melds[meldIndex];
    if (!currentMeld) return;

    let testMeld = [...currentMeld, cardToAdd];
    if (!isValidSingleMeld(testMeld)) {
      return socket.emit('error-msg', 'هذه الإضافة غير قانونية للمجموعة!');
    }

    player.hand.splice(cardIndex, 1);
    room.melds[meldIndex] = testMeld;
    socket.emit('your-hand', player.hand);
    sendGameState(roomCode);
  });

  // رمي الورقة، إنهاء الدور، وقواعد التسكير والعقوبات (القواعد 9، 10، 11، 12، 15)
  socket.on('discard-card', ({ roomCode, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.hasDrawn) return;

    const player = room.players[room.turnIndex];
    if (player.id !== socket.id) return;

    // قاعدة 13: إذا سحب اللاعب من الحرق يجب عليه النزول ولا يحق له الرمي المباشر إذا كان عليه قيد
    if (room.lastActionWasDiscardFromBurn && !player.hasMelded) {
      return socket.emit('error-msg', 'لا يمكنك رمي هذه الورقة فوراً، يجب عليك النزول أولاً لأنك سحبت من ورقة الحرق!');
    }

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      const [discarded] = player.hand.splice(cardIndex, 1);
      room.discardPile.push(discarded);

      // قاعدة 10 و 11 و 12: التسكير ونهاية الجولة وحساب النقاط
      if (player.hand.length === 0) {
        room.players.forEach(p => {
          if (!p.hasMelded) {
            p.score += 100; // قاعدة 12: عقوبة 100 نقطة لمن لم ينزل نهائياً
          } else {
            p.score += p.hand.reduce((sum, c) => sum + getCardScore(c), 0);
          }
        });

        io.to(roomCode).emit('game-over', { winner: player.name, players: room.players });
        room.started = false;
        return;
      }

      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.hasDrawn = false;
      room.lastActionWasDiscardFromBurn = false;

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    }
  });

});

function handleCreateRoom(socket, name, cb) {
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  rooms[code] = {
    code: code,
    players: [{ id: socket.id, name: name || 'لاعب', hand: [], hasMelded: false, score: 0 }],
    deck: [],
    discardPile: [],
    melds: [],
    turnIndex: 0,
    round: 1,
    started: false,
    hasDrawn: false,
    lastActionWasDiscardFromBurn: false
  };
  socket.join(code);
  if (typeof cb === 'function') {
    cb({ success: true, code });
  } else {
    socket.emit('room-created', { success: true, code });
  }
}

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
    melds: room.melds,
    players: room.players
  });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
