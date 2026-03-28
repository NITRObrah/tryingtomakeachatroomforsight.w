/**
 * Real-Time Chatroom Server - Fixed Version
 * 
 * Architecture: [Browser] <--> [WebSocket] <--> [Node.js Server] <--> [Redis/Memory]
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// ============================================
// Message Types
// ============================================
const MessageType = {
  CHAT: 'chat',
  JOIN: 'join',
  LEAVE: 'leave',
  USER_LIST: 'user_list'
};

// ============================================
// In-Memory Storage
// ============================================
class MemoryStore {
  constructor(maxMessages = 100) {
    this.messages = [];
    this.users = new Set();
    this.maxMessages = maxMessages;
  }

  saveMessage(msg) {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  getRecentMessages(limit = 50) {
    return this.messages.slice(-limit);
  }

  addUser(nickname) {
    this.users.add(nickname);
  }

  removeUser(nickname) {
    this.users.delete(nickname);
  }

  getUsers() {
    return Array.from(this.users);
  }
}

// ============================================
// ChatRoom - Core Logic
// ============================================
class ChatRoom {
  constructor(store) {
    this.clients = new Map(); // nickname -> { ws, nickname }
    this.store = store;
    console.log('✅ ChatRoom initialized');
  }

  // Register a new client
  register(nickname, ws) {
    // Handle duplicate nicknames
    let finalNickname = nickname;
    let counter = 1;
    while (this.clients.has(finalNickname)) {
      finalNickname = `${nickname}_${counter}`;
      counter++;
    }

    this.clients.set(finalNickname, { ws, nickname: finalNickname });
    this.store.addUser(finalNickname);

    console.log(`📥 Client registered: ${finalNickname} (Total: ${this.clients.size})`);

    // Send message history to new client
    this.sendHistory(ws);

    // Broadcast join message
    this.broadcast({
      type: MessageType.JOIN,
      nickname: finalNickname,
      content: 'joined the chat! 🎉',
      timestamp: new Date().toISOString()
    });

    // Update user list
    this.broadcastUserList();

    return finalNickname;
  }

  // Unregister a client
  unregister(nickname) {
    if (this.clients.has(nickname)) {
      this.clients.delete(nickname);
      this.store.removeUser(nickname);

      console.log(`📤 Client left: ${nickname} (Total: ${this.clients.size})`);

      // Broadcast leave message
      this.broadcast({
        type: MessageType.LEAVE,
        nickname: nickname,
        content: 'left the chat. 👋',
        timestamp: new Date().toISOString()
      });

      // Update user list
      this.broadcastUserList();
    }
  }

  // Handle incoming chat message
  handleChatMessage(nickname, content) {
    const msg = {
      type: MessageType.CHAT,
      nickname: nickname,
      content: content,
      timestamp: new Date().toISOString()
    };

    // Save to store
    this.store.saveMessage(msg);

    // Broadcast to all clients
    this.broadcast(msg);

    console.log(`💬 ${nickname}: ${content}`);
  }

  // Broadcast message to all clients
  broadcast(message) {
    const data = JSON.stringify(message);
    let sent = 0;

    for (const [nickname, client] of this.clients) {
      try {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data);
          sent++;
        }
      } catch (err) {
        console.error(`❌ Error sending to ${nickname}:`, err.message);
      }
    }

    console.log(`   ↗️  Broadcast to ${sent} clients`);
  }

  // Send message history to a client
  sendHistory(ws) {
    const messages = this.store.getRecentMessages(50);
    for (const msg of messages) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      } catch (err) {
        break;
      }
    }
  }

  // Broadcast user list to all clients
  broadcastUserList() {
    const users = this.store.getUsers();
    const msg = {
      type: MessageType.USER_LIST,
      users: users,
      timestamp: new Date().toISOString()
    };
    this.broadcast(msg);
  }
}

// ============================================
// Utility Functions
// ============================================
function generateID() {
  return Math.random().toString(36).substring(2, 6);
}

// ============================================
// Main Application
// ============================================
function main() {
  // Create store
  const store = new MemoryStore(100);

  // Create chatroom
  const chatRoom = new ChatRoom(store);

  // Setup Express
  const app = express();
  const server = http.createServer(app);

  // Serve static files
  app.use(express.static(path.join(__dirname, 'static')));

  // API endpoints
  app.get('/api/users', (req, res) => {
    res.json({ users: store.getUsers() });
  });

  app.get('/api/messages', (req, res) => {
    res.json({ messages: store.getRecentMessages(50) });
  });

  // Setup WebSocket server
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    // Get nickname from URL query params
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    let nickname = urlObj.searchParams.get('nickname') || `Anonymous_${generateID()}`;

    console.log(`\n🔌 New WebSocket connection from ${req.socket.remoteAddress}`);
    console.log(`   Nickname: ${nickname}`);

    // Register client
    const finalNickname = chatRoom.register(nickname, ws);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'system',
      content: `Welcome to the chat, ${finalNickname}!`,
      timestamp: new Date().toISOString()
    }));

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const content = data.toString().trim();
        if (content) {
          chatRoom.handleChatMessage(finalNickname, content);
        }
      } catch (err) {
        console.error('❌ Message handling error:', err);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`🔌 Connection closed: ${finalNickname}`);
      chatRoom.unregister(finalNickname);
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error(`❌ WebSocket error for ${finalNickname}:`, err.message);
      chatRoom.unregister(finalNickname);
    });

    // Keep connection alive with ping/pong
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  // Ping all clients every 30 seconds
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  // Start server
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log('\n=================================');
    console.log('🚀 Chatroom Server Started!');
    console.log('=================================');
    console.log(`📡 HTTP:      http://localhost:${PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}/ws?nickname=YourName`);
    console.log('=================================\n');
  });
}

// Run the application
main();
