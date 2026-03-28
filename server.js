

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const Redis = require('ioredis');

// ============================================
// Message Types
// ============================================
const MessageType = {
  CHAT: 'chat',
  JOIN: 'join',
  LEAVE: 'leave',
  USER_LIST: 'user_list',
  SYSTEM: 'system'
};

// ============================================
// Storage Interface (Memory & Redis)
// ============================================

/**
 * In-Memory Storage Implementation
 * Similar to Go's MemoryStore struct
 */
class MemoryStore {
  constructor(maxMessages = 100) {
    this.messages = [];
    this.users = new Set();
    this.maxMessages = maxMessages;
  }

  async saveMessage(msg) {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  async getRecentMessages(limit = 50) {
    if (limit <= 0 || limit > this.messages.length) {
      return [...this.messages];
    }
    return this.messages.slice(-limit);
  }

  async addUser(nickname) {
    this.users.add(nickname);
  }

  async removeUser(nickname) {
    this.users.delete(nickname);
  }

  async getUsers() {
    return Array.from(this.users);
  }
}

/**
 * Redis Storage Implementation
 * Similar to Go's RedisStore struct
 */
class RedisStore {
  constructor(redisClient, maxMessages = 100) {
    this.client = redisClient;
    this.msgKey = 'chatroom:messages';
    this.userSetKey = 'chatroom:users';
    this.maxMessages = maxMessages;
  }

  async saveMessage(msg) {
    const data = JSON.stringify(msg);
    await this.client.rpush(this.msgKey, data);
    await this.client.ltrim(this.msgKey, -this.maxMessages, -1);
  }

  async getRecentMessages(limit = 50) {
    const results = await this.client.lrange(this.msgKey, -limit, -1);
    return results.map(data => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  async addUser(nickname) {
    await this.client.sadd(this.userSetKey, nickname);
  }

  async removeUser(nickname) {
    await this.client.srem(this.userSetKey, nickname);
  }

  async getUsers() {
    return await this.client.smembers(this.userSetKey);
  }
}

// ============================================
// ChatRoom - Core Logic (Like Go's ChatRoom struct)
// ============================================

/**
 * ChatRoom manages all clients and message broadcasting
 * Uses channel-like patterns with EventEmitter
 */
class ChatRoom {
  constructor(store) {
    this.clients = new Map(); // Map<nickname, Client>
    this.store = store;
    
    // "Channels" for message passing (like Go channels)
    this.registerQueue = [];
    this.unregisterQueue = [];
    this.broadcastQueue = [];
    
    // Start the event loop (like Go's Run() goroutine)
    this.runEventLoop();
  }

  /**
   * Main event loop - similar to Go's select statement
   * Processes register, unregister, and broadcast "channels"
   */
  async runEventLoop() {
    setInterval(() => {
      // Process registration queue
      while (this.registerQueue.length > 0) {
        const client = this.registerQueue.shift();
        this.handleRegister(client);
      }

      // Process unregistration queue
      while (this.unregisterQueue.length > 0) {
        const client = this.unregisterQueue.shift();
        this.handleUnregister(client);
      }

      // Process broadcast queue
      while (this.broadcastQueue.length > 0) {
        const message = this.broadcastQueue.shift();
        this.handleBroadcast(message);
      }
    }, 10); // Process every 10ms
  }

  /**
   * Register a new client (like Go: cr.register <- client)
   */
  register(client) {
    this.registerQueue.push(client);
  }

  /**
   * Unregister a client (like Go: cr.unregister <- client)
   */
  unregister(client) {
    this.unregisterQueue.push(client);
  }

  /**
   * Broadcast a message (like Go: cr.broadcast <- message)
   */
  broadcast(message) {
    this.broadcastQueue.push(message);
  }

  /**
   * Handle client registration
   */
  async handleRegister(client) {
    this.clients.set(client.nickname, client);
    await this.store.addUser(client.nickname);

    // Send message history to new client
    await this.sendHistory(client);

    // Broadcast join message
    const joinMsg = {
      type: MessageType.JOIN,
      nickname: client.nickname,
      content: 'joined the chat! 🎉',
      timestamp: new Date().toISOString()
    };
    this.broadcast(joinMsg);

    // Update user list for all clients
    this.broadcastUserList();

    console.log(`Client connected: ${client.nickname} (Total: ${this.clients.size})`);
  }

  /**
   * Handle client disconnection
   */
  async handleUnregister(client) {
    if (this.clients.has(client.nickname)) {
      this.clients.delete(client.nickname);
      await this.store.removeUser(client.nickname);

      // Broadcast leave message
      const leaveMsg = {
        type: MessageType.LEAVE,
        nickname: client.nickname,
        content: 'left the chat. 👋',
        timestamp: new Date().toISOString()
      };
      this.broadcast(leaveMsg);

      // Update user list
      this.broadcastUserList();

      console.log(`Client disconnected: ${client.nickname} (Total: ${this.clients.size})`);
    }
  }

  /**
   * Handle message broadcasting
   */
  async handleBroadcast(message) {
    // Save message to store
    await this.store.saveMessage(message);

    // Send to all clients
    const data = JSON.stringify(message);
    for (const [nickname, client] of this.clients) {
      try {
        client.send(data);
      } catch (err) {
        console.error(`Error sending to ${nickname}:`, err.message);
      }
    }
  }

  /**
   * Send message history to a client
   */
  async sendHistory(client) {
    const messages = await this.store.getRecentMessages(50);
    for (const msg of messages) {
      try {
        client.send(JSON.stringify(msg));
      } catch (err) {
        break;
      }
    }
  }

  /**
   * Broadcast user list to all clients
   */
  async broadcastUserList() {
    const users = await this.store.getUsers();
    const msg = {
      type: MessageType.USER_LIST,
      users: users,
      timestamp: new Date().toISOString()
    };
    const data = JSON.stringify(msg);

    for (const client of this.clients.values()) {
      try {
        client.send(data);
      } catch (err) {
        // Ignore errors
      }
    }
  }

  /**
   * Handle WebSocket connection
   */
  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let nickname = url.searchParams.get('nickname') || `Anonymous_${generateID()}`;

    // Ensure unique nickname
    if (this.clients.has(nickname)) {
      nickname = `${nickname}_${generateID()}`;
    }

    // Create client object
    const client = {
      ws: ws,
      nickname: nickname,
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      }
    };

    // Register client
    this.register(client);

    // Handle incoming messages (like Go's readPump goroutine)
    ws.on('message', (data) => {
      try {
        const content = data.toString();
        if (content.trim()) {
          const msg = {
            type: MessageType.CHAT,
            nickname: client.nickname,
            content: content,
            timestamp: new Date().toISOString()
          };
          this.broadcast(msg);
        }
      } catch (err) {
        console.error('Message handling error:', err);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      this.unregister(client);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.unregister(client);
    });

    // Send ping to keep connection alive (like Go's writePump ticker)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
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

async function main() {
  // Initialize storage (try Redis first, fallback to memory)
  let store;
  
  try {
    const redisClient = new Redis({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });

    await redisClient.ping();
    console.log('✅ Connected to Redis for message storage');
    store = new RedisStore(redisClient);
  } catch (err) {
    console.log('⚠️  Redis not available, using in-memory storage');
    store = new MemoryStore();
  }

  // Create chatroom
  const chatRoom = new ChatRoom(store);

  // Setup Express
  const app = express();
  const server = http.createServer(app);

  // Serve static files
  app.use(express.static(path.join(__dirname, 'static')));

  // Serve index.html at root
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
  });

  // API endpoints
  app.get('/api/users', async (req, res) => {
    const users = await store.getUsers();
    res.json({ users });
  });

  app.get('/api/messages', async (req, res) => {
    const messages = await store.getRecentMessages(50);
    res.json({ messages });
  });

  // Setup WebSocket server
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    chatRoom.handleConnection(ws, req);
  });

  // Start server
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`🚀 Chatroom server running on http://localhost:${PORT}`);
    console.log('📡 WebSocket endpoint: ws://localhost:' + PORT + '/ws');
  });
}

// Run the application
main().catch(console.error);
