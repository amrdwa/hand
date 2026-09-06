const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

// مصفوفة ألوان مميزة للمجموعات على الطاولة (كل نزول جديد يأخذ لون مختلف)
const meldColors = [
  '#FF5733', // أحمر برتقالي
  '#33FF57', // أخضر ساطع
  '#3357FF', // أزرق
  '#F3FF33', // أصفر
  '#FF33F3', // وردي
  '#33FFF3', // سماوي
  '#FFA533', // برتقالي
  '#A833FF'  // بنفسجي
];

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
  
  if (nonJokers.length > 0) {
    let firstVal = nonJokers[0].value;
    let isSameSet = nonJokers.every(c => c.value === firstVal);
    let suits = new Set(nonJokers.map(c => c.suit));
    if (isSameSet && suits.size === nonJokers.length && sub.length >= 3 && sub.length <= 4) {
      return true;
    }
  }

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
    room.lastActionWasDiscardFromBurn = false;

    room.players.forEach((p, index) => {
      p.hasMelded = false;
      p.melds = [];
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
      room.lastActionWasDiscardFromBurn = true;
    } else if (room.deck.length > 0) {
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

  // النزول التلقائي بناءً على المجموعات المصفطة بيد اللاعب عند ضغط زر النزول
  socket.on('meld-cards', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    let handCards = [...player.hand];
    let verifiedGroups = [];
    let totalScore = 0;

    let availableCards = [...handCards];
    let foundNewMeld = true;

    while (foundNewMeld) {
      foundNewMeld = false;
      for (let len = availableCards.length; len >= 3; len--) {
        let matched = false;
        for (let i = 0; i <= availableCards.length - len; i++) {
          let candidate = availableCards.slice(i, i + len);
          if (isValidSingleMeld(candidate)) {
            verifiedGroups.push(candidate);
            totalScore += candidate.reduce((s, c) => s + getCardScore(c, candidate), 0);
            
            availableCards.splice(i, len);
            foundNewMeld = true;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }

    if (!player.hasMelded && totalScore < 51) {
      return socket.emit('error-msg', `مجموع الكروت المترتبة في يدك هو ${totalScore} ولا يفي بشرط الـ 51 نقطة للنزول الأول!`);
    }

    if (verifiedGroups.length > 0) {
      let cardsToRemove = verifiedGroups.flat().map(c => c.id);
      
      player.hand = player.hand.filter(c => !cardsToRemove.includes(c.id));
      player.hasMelded = true;
      room.lastActionWasDiscardFromBurn = false;

      verifiedGroups.forEach(group => {
        const assignedColor = meldColors[room.melds.length % meldColors.length];
        room.melds.push({ cards: group, color: assignedColor });
      });

      socket.emit('your-hand', player.hand);
      sendGameState(roomCode);
    } else {
      socket.emit('error-msg', 'لا توجد أي مجموعات صحيحة أو مرتبة في يدك للنزول بها');
    }
  });

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
    const targetMeldObj = room.melds[meldIndex];
    if (!targetMeldObj) return;

    let testMeld = [...targetMeldObj.cards, cardToAdd];
    if (!isValidSingleMeld(testMeld)) {
      return socket.emit('error-msg', 'هذه الإضافة غير قانونية للمجموعة!');
    }

    player.hand.splice(cardIndex, 1);
    targetMeldObj.cards = testMeld;
    socket.emit('your-hand', player.hand);
    sendGameState(roomCode);
  });

  socket.on('discard-card', ({ roomCode, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.hasDrawn) return;

    const player = room.players[room.turnIndex];
    if (player.id !== socket.id) return;

    if (room.lastActionWasDiscardFromBurn && !player.hasMelded) {
      return socket.emit('error-msg', 'لا يمكنك رمي هذه الورقة فوراً، يجب عليك النزول أولاً لأنك سحبت من ورقة الحرق!');
    }

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      const [discarded] = player.hand.splice(cardIndex, 1);
      room.discardPile.push(discarded);

      if (player.hand.length === 0) {
        room.players.forEach(p => {
          if (!p.hasMelded) {
            p.score += 100;
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
