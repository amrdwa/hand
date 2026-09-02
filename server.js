const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

let rooms = {};

io.on('connection', (socket) => {
  
  socket.on('create-room', ({ name }, cb) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[code] = { players: [{ id: socket.id, name }], melds: [], turnIndex: 0 };
    socket.join(code);
    cb({ success: true, code });
  });

  socket.on('join-room', ({ name, code }, cb) => {
    if (rooms[code]) {
      rooms[code].players.push({ id: socket.id, name });
      socket.join(code);
      cb({ success: true });
    } else {
      cb({ success: false, message: 'الغرفة غير موجودة' });
    }
  });

  socket.on('meld-cards', ({ roomCode, cardIds }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // هنا يتم التحقق من أن المجموعات صحيحية (متسلسلة بنفس اللون أو تشابه في الأرقام مع مجموع ≥ 51)
    const isValidMeld = validateSaudiHandMeld(cardIds);

    if (isValidMeld.valid) {
      // تنزيل المجموعة على الطاولة
      room.melds.push(isValidMeld.cards);
      io.to(roomCode).emit('game-state', room);
    } else {
      // إرسال التنبيه المطابق لـ جواكر
      socket.emit('error-msg', 'الورقة التي أضفتها خاطئة أو في المكان الخاطئ');
    }
  });
});

function validateSaudiHandMeld(cardIds) {
  // يتم وضع شروط الـ 51 نقطة والتركيبات المسموحة هنا
  // إرجاع true عند الصحة
  return { valid: true, cards: [] }; 
}

http.listen(3000, () => console.log('Server running on port 3000'));
