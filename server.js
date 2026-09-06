const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDeck() {
    let deck = [];
    for (let r = 0; r < 2; r++) {
        for (let suit of suits) {
            for (let val of values) {
                deck.push({ suit, val, id: `${suit}_${val}_${r}_${Math.random()}` });
            }
        }
    }
    for (let i = 0; i < 2; i++) {
        deck.push({ suit: 'joker', val: 'JOKER', id: `joker_${i}_${Math.random()}` });
    }
    
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

let gameState = {
    players: [],
    stockPile: [],
    discardPile: [],
    turnIndex: 0,
    gameStarted: false,
    lastActionWasDiscardFromBurn: false
};

function initializeGameRound(players) {
    let deck = createDeck();

    players.forEach(player => {
        player.hand = deck.splice(0, 14);
        player.melds = [];
        player.hasMelled = false;
        player.score = 0;
    });

    if (players.length > 0) {
        players[0].hand.push(deck.splice(0, 1)[0]);
    }

    gameState.stockPile = deck;
    gameState.discardPile = [gameState.stockPile.splice(0, 1)[0]];
    gameState.turnIndex = 0;
    gameState.gameStarted = true;
}

function getCardPoint(card) {
    if (card.suit === 'joker') return 15;
    if (card.val === 'A') return 11;
    if (['J', 'Q', 'K'].includes(card.val)) return 10;
    return parseInt(card.val);
}

// دالة التحقق من صحة المجموعات الأساسية
function validateMeld(meldCards) {
    if (!meldCards || meldCards.length < 3) return { valid: false, points: 0, type: null };

    let nonJokers = meldCards.filter(c => c.suit !== 'joker');
    let firstVal = nonJokers[0]?.val;
    let isSet = nonJokers.every(c => c.val === firstVal);

    if (isSet) {
        let suitsSet = new Set();
        let points = 0;
        for (let card of meldCards) {
            if (card.suit !== 'joker') {
                if (suitsSet.has(card.suit)) return { valid: false, points: 0 };
                suitsSet.add(card.suit);
            }
            points += (card.suit === 'joker' ? (firstVal === 'A' ? 11 : (['J','Q','K'].includes(firstVal) ? 10 : parseInt(firstVal) || 10)) : getCardPoint(card));
        }
        return { valid: true, points, type: 'set' };
    }

    let firstSuit = nonJokers[0]?.suit;
    let sameSuit = nonJokers.every(c => c.suit === firstSuit);
    if (!sameSuit) return { valid: false, points: 0 };

    return { 
        valid: true, 
        points: meldCards.reduce((sum, c) => sum + (c.suit === 'joker' ? 10 : getCardPoint(c)), 0), 
        type: 'sequence' 
    };
}

io.on('connection', (socket) => {
    console.log(`مستخدم متصل: ${socket.id}`);

    socket.on('join_game', (name) => {
        if (gameState.gameStarted) {
            socket.emit('error_msg', 'اللعبة جارية بالفعل!');
            return;
        }
        gameState.players.push({
            id: socket.id,
            name: name || `لاعب ${gameState.players.length + 1}`,
            hand: [],
            melds: [],
            hasMelled: false,
            score: 0
        });
        io.emit('update_state', gameState);
    });

    socket.on('start_game', () => {
        if (gameState.players.length < 2) {
            socket.emit('error_msg', 'يجب تواجد لاعبان على الأقل لبدء اللعبة!');
            return;
        }
        initializeGameRound(gameState.players);
        io.emit('update_state', gameState);
    });

    // السحب (قواعد السحب من المجموع أو الحرق)
    socket.on('draw_card', (source) => {
        let player = gameState.players[gameState.turnIndex];
        if (!player || socket.id !== player.id) return;

        if (source === 'stock') {
            if (gameState.stockPile.length === 0) {
                let topBurn = gameState.discardPile.pop();
                gameState.stockPile = createDeck();
                gameState.discardPile = [topBurn];
            }
            let drawnCard = gameState.stockPile.splice(0, 1)[0];
            player.hand.push(drawnCard);
            gameState.lastActionWasDiscardFromBurn = false;
            io.emit('update_state', gameState);

        } else if (source === 'burn') {
            if (gameState.discardPile.length === 0) return;
            let drawnCard = gameState.discardPile.pop();
            player.hand.push(drawnCard);
            gameState.lastActionWasDiscardFromBurn = true;
            io.emit('update_state', gameState);
        }
    });

    // النزول الأول (شرط الـ 51 نقطة) أو النزول اللاحق
    socket.on('meld_cards', (selectedMelds) => {
        let player = gameState.players[gameState.turnIndex];
        if (!player || socket.id !== player.id) return;

        let totalPoints = 0;
        let validatedMelds = [];

        for (let m of selectedMelds) {
            let res = validateMeld(m);
            if (!res.valid) {
                socket.emit('error_msg', 'إحدى المجموعات غير قانونية!');
                return;
            }
            totalPoints += res.points;
            validatedMelds.push(m);
        }

        if (!player.hasMelled) {
            if (totalPoints < 51) {
                socket.emit('error_msg', `مجموع نقاط النزول الأول ${totalPoints}، ويجب ألا يقل عن 51 نقطة!`);
                return;
            }
        }

        validatedMelds.forEach(meld => {
            meld.forEach(card => {
                let cardIndex = player.hand.findIndex(c => c.id === card.id);
                if (cardIndex !== -1) {
                    player.hand.splice(cardIndex, 1);
                }
            });
            player.melds.push(meld);
        });

        player.hasMelled = true;
        gameState.lastActionWasDiscardFromBurn = false;
        io.emit('update_state', gameState);
    });

    // إضافة أوراق إلى مجموعات موجودة مسبقاً على الطاولة
    socket.on('add_to_meld', ({ targetPlayerId, meldIndex, cardId }) => {
        let player = gameState.players[gameState.turnIndex];
        if (!player || socket.id !== player.id) return;
        if (!player.hasMelled) {
            socket.emit('error_msg', 'يجب أن تنزل أولاً قبل الإضافة على المجموعات!');
            return;
        }

        let targetPlayer = gameState.players.find(p => p.id === targetPlayerId);
        if (!targetPlayer || !targetPlayer.melds[meldIndex]) return;

        let cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;

        let cardToAdd = player.hand[cardIndex];
        let currentMeld = targetPlayer.melds[meldIndex];
        
        // اختبار صحة المجموعة بعد الإضافة
        let testMeld = [...currentMeld, cardToAdd];
        let validation = validateMeld(testMeld);

        if (!validation.valid) {
            socket.emit('error_msg', 'هذه الإضافة غير قانونية للمجموعة!');
            return;
        }

        player.hand.splice(cardIndex, 1);
        targetPlayer.melds[meldIndex] = testMeld;
        io.emit('update_state', gameState);
    });

    // رمي الورقة وإنهاء الدور (مع حساب عقوبات عدم النزول أو التسكير)
    socket.on('discard_card', (cardId) => {
        let player = gameState.players[gameState.turnIndex];
        if (!player || socket.id !== player.id) return;

        if (gameState.lastActionWasDiscardFromBurn) {
            socket.emit('error_msg', 'يجب أن تقوم بنزول قانوني على الطاولة لأنك سحبت من ورقة الحرق!');
            return;
        }

        let cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;

        let discardedCard = player.hand.splice(cardIndex, 1)[0];
        gameState.discardPile.push(discardedCard);

        // التحقق من التسكير (إنهاء الجولة)
        if (player.hand.length === 0) {
            // حساب النقاط والعقوبات لباقي اللاعبين (مثل عقوبة 100 نقطة لمن لم ينزل)
            gameState.players.forEach(p => {
                if (!p.hasMelled) {
                    p.score += 100; // عقوبة عدم النزول
                } else {
                    // حساب مجموع الأوراق المتبقية في يد اللاعبين الآخرين
                    let penalty = p.hand.reduce((sum, c) => sum + getCardPoint(c), 0);
                    p.score += penalty;
                }
            });

            io.emit('game_over', { winner: player.name, players: gameState.players });
            gameState.gameStarted = false;
            return;
        }

        gameState.turnIndex = (gameState.turnIndex - 1 + gameState.players.length) % gameState.players.length;
        io.emit('update_state', gameState);
    });

    socket.on('disconnect', () => {
        console.log(`مستخدم منفصل: ${socket.id}`);
    });
});

server.listen(3000, () => {
    console.log('خادم الهاند السعودية يعمل بنجاح على المنفذ 3000');
});
