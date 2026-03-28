package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ============================================
// WebSocket Upgrader Configuration
// ============================================
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

// ============================================
// Message Types
// ============================================

// MessageType defines the type of message
type MessageType string

const (
	MessageTypeChat     MessageType = "chat"
	MessageTypeJoin     MessageType = "join"
	MessageTypeLeave    MessageType = "leave"
	MessageTypeUserList MessageType = "user_list"
	MessageTypeSystem   MessageType = "system"
)

// Message represents a chat message
type Message struct {
	Type      MessageType `json:"type"`
	Nickname  string      `json:"nickname"`
	Content   string      `json:"content"`
	Timestamp time.Time   `json:"timestamp"`
	Users     []string    `json:"users,omitempty"`
}

// ============================================
// Client Structure
// ============================================

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	send     chan []byte
	nickname string
	room     *ChatRoom
}

// ============================================
// Storage Interface (Memory & Redis)
// ============================================

// MessageStore defines the interface for message storage
type MessageStore interface {
	SaveMessage(ctx context.Context, msg Message) error
	GetRecentMessages(ctx context.Context, limit int) ([]Message, error)
	AddUser(ctx context.Context, nickname string) error
	RemoveUser(ctx context.Context, nickname string) error
	GetUsers(ctx context.Context) ([]string, error)
}

// ============================================
// In-Memory Storage Implementation
// ============================================

// MemoryStore implements MessageStore using in-memory storage
type MemoryStore struct {
	messages []Message
	users    map[string]bool
	mu       sync.RWMutex
	maxMessages int
}

// NewMemoryStore creates a new in-memory store
func NewMemoryStore(maxMessages int) *MemoryStore {
	return &MemoryStore{
		messages:    make([]Message, 0),
		users:       make(map[string]bool),
		maxMessages: maxMessages,
	}
}

// SaveMessage saves a message to memory
func (m *MemoryStore) SaveMessage(ctx context.Context, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	m.messages = append(m.messages, msg)
	
	// Keep only the last maxMessages
	if len(m.messages) > m.maxMessages {
		m.messages = m.messages[len(m.messages)-m.maxMessages:]
	}
	return nil
}

// GetRecentMessages retrieves recent messages from memory
func (m *MemoryStore) GetRecentMessages(ctx context.Context, limit int) ([]Message, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	if limit <= 0 || limit > len(m.messages) {
		return m.messages, nil
	}
	
	return m.messages[len(m.messages)-limit:], nil
}

// AddUser adds a user to the store
func (m *MemoryStore) AddUser(ctx context.Context, nickname string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.users[nickname] = true
	return nil
}

// RemoveUser removes a user from the store
func (m *MemoryStore) RemoveUser(ctx context.Context, nickname string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.users, nickname)
	return nil
}

// GetUsers returns all connected users
func (m *MemoryStore) GetUsers(ctx context.Context) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	users := make([]string, 0, len(m.users))
	for user := range m.users {
		users = append(users, user)
	}
	return users, nil
}

// ============================================
// Redis Storage Implementation
// ============================================

// RedisStore implements MessageStore using Redis
type RedisStore struct {
	client     *redis.Client
	msgKey     string
	userSetKey string
	maxMessages int64
}

// NewRedisStore creates a new Redis store
func NewRedisStore(addr string, maxMessages int64) *RedisStore {
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: "",
		DB:       0,
	})
	
	return &RedisStore{
		client:      client,
		msgKey:      "chatroom:messages",
		userSetKey:  "chatroom:users",
		maxMessages: maxMessages,
	}
}

// SaveMessage saves a message to Redis
func (r *RedisStore) SaveMessage(ctx context.Context, msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	// Add to list
	r.client.RPush(ctx, r.msgKey, data)
	
	// Trim to maxMessages
	r.client.LTrim(ctx, r.msgKey, -r.maxMessages, -1)
	
	return nil
}

// GetRecentMessages retrieves recent messages from Redis
func (r *RedisStore) GetRecentMessages(ctx context.Context, limit int) ([]Message, error) {
	results, err := r.client.LRange(ctx, r.msgKey, int64(-limit), -1).Result()
	if err != nil {
		return nil, err
	}
	
	messages := make([]Message, 0, len(results))
	for _, data := range results {
		var msg Message
		if err := json.Unmarshal([]byte(data), &msg); err == nil {
			messages = append(messages, msg)
		}
	}
	return messages, nil
}

// AddUser adds a user to Redis
func (r *RedisStore) AddUser(ctx context.Context, nickname string) error {
	return r.client.SAdd(ctx, r.userSetKey, nickname).Err()
}

// RemoveUser removes a user from Redis
func (r *RedisStore) RemoveUser(ctx context.Context, nickname string) error {
	return r.client.SRem(ctx, r.userSetKey, nickname).Err()
}

// GetUsers returns all connected users from Redis
func (r *RedisStore) GetUsers(ctx context.Context) ([]string, error) {
	return r.client.SMembers(ctx, r.userSetKey).Result()
}

// ============================================
// ChatRoom Structure
// ============================================

// ChatRoom manages all clients and message broadcasting
type ChatRoom struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan Message
	store      MessageStore
	mu         sync.RWMutex
}

// NewChatRoom creates a new chatroom
func NewChatRoom(store MessageStore) *ChatRoom {
	return &ChatRoom{
		clients:    make(map[*Client]bool),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
		broadcast:  make(chan Message, 1024),
		store:      store,
	}
}

// Run starts the chatroom's main event loop (Goroutine)
// This uses Go channels for concurrent message handling
func (cr *ChatRoom) Run() {
	for {
		select {
		case client := <-cr.register:
			cr.handleRegister(client)
			
		case client := <-cr.unregister:
			cr.handleUnregister(client)
			
		case message := <-cr.broadcast:
			cr.handleBroadcast(message)
		}
	}
}

// handleRegister processes new client registration
func (cr *ChatRoom) handleRegister(client *Client) {
	cr.mu.Lock()
	cr.clients[client] = true
	cr.mu.Unlock()
	
	// Add user to store
	ctx := context.Background()
	cr.store.AddUser(ctx, client.nickname)
	
	// Send message history to new client
	cr.sendHistory(client)
	
	// Broadcast join message
	joinMsg := Message{
		Type:      MessageTypeJoin,
		Nickname:  client.nickname,
		Content:   "joined the chat! 🎉",
		Timestamp: time.Now(),
	}
	cr.broadcast <- joinMsg
	
	// Update user list for all clients
	cr.broadcastUserList()
	
	log.Printf("Client connected: %s (Total: %d)", client.nickname, len(cr.clients))
}

// handleUnregister processes client disconnection
func (cr *ChatRoom) handleUnregister(client *Client) {
	cr.mu.Lock()
	if _, ok := cr.clients[client]; ok {
		delete(cr.clients, client)
		close(client.send)
	}
	cr.mu.Unlock()
	
	// Remove user from store
	ctx := context.Background()
	cr.store.RemoveUser(ctx, client.nickname)
	
	// Broadcast leave message
	leaveMsg := Message{
		Type:      MessageTypeLeave,
		Nickname:  client.nickname,
		Content:   "left the chat. 👋",
		Timestamp: time.Now(),
	}
	cr.broadcast <- leaveMsg
	
	// Update user list for remaining clients
	cr.broadcastUserList()
	
	log.Printf("Client disconnected: %s (Total: %d)", client.nickname, len(cr.clients))
}

// handleBroadcast sends a message to all connected clients
func (cr *ChatRoom) handleBroadcast(message Message) {
	// Save message to store
	ctx := context.Background()
	cr.store.SaveMessage(ctx, message)
	
	// Marshal message to JSON
	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Error marshaling message: %v", err)
		return
	}
	
	// Send to all clients
	cr.mu.RLock()
	for client := range cr.clients {
		select {
		case client.send <- data:
		default:
			// Client's buffer is full, close the connection
			close(client.send)
			delete(cr.clients, client)
		}
	}
	cr.mu.RUnlock()
}

// sendHistory sends recent messages to a newly connected client
func (cr *ChatRoom) sendHistory(client *Client) {
	ctx := context.Background()
	messages, err := cr.store.GetRecentMessages(ctx, 50)
	if err != nil {
		log.Printf("Error getting message history: %v", err)
		return
	}
	
	for _, msg := range messages {
		data, err := json.Marshal(msg)
		if err != nil {
			continue
		}
		select {
		case client.send <- data:
		default:
			return
		}
	}
}

// broadcastUserList sends the current user list to all clients
func (cr *ChatRoom) broadcastUserList() {
	ctx := context.Background()
	users, err := cr.store.GetUsers(ctx)
	if err != nil {
		log.Printf("Error getting users: %v", err)
		return
	}
	
	msg := Message{
		Type:      MessageTypeUserList,
		Users:     users,
		Timestamp: time.Now(),
	}
	
	data, _ := json.Marshal(msg)
	
	cr.mu.RLock()
	for client := range cr.clients {
		select {
		case client.send <- data:
		default:
		}
	}
	cr.mu.RUnlock()
}

// HandleWebSocket upgrades HTTP connection to WebSocket
func (cr *ChatRoom) HandleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	
	nickname := c.Query("nickname")
	if nickname == "" {
		nickname = "Anonymous_" + generateID()
	}
	
	client := &Client{
		conn:     conn,
		send:     make(chan []byte, 256),
		nickname: nickname,
		room:     cr,
	}
	
	cr.register <- client
	
	// Start goroutines for reading and writing
	go client.writePump()
	go client.readPump()
}

// ============================================
// Client Methods
// ============================================

// readPump reads messages from the WebSocket connection
func (c *Client) readPump() {
	defer func() {
		c.room.unregister <- c
		c.conn.Close()
	}()
	
	// Set read limit and deadline
	c.conn.SetReadLimit(512)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	
	// Set pong handler to keep connection alive
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Read error: %v", err)
			}
			break
		}
		
		// Create and broadcast chat message
		msg := Message{
			Type:      MessageTypeChat,
			Nickname:  c.nickname,
			Content:   string(message),
			Timestamp: time.Now(),
		}
		c.room.broadcast <- msg
	}
}

// writePump writes messages to the WebSocket connection
func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			
			// Batch messages from the channel
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}
			
			if err := w.Close(); err != nil {
				return
			}
			
		case <-ticker.C:
			// Send ping to keep connection alive
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ============================================
// Utility Functions
// ============================================

// generateID generates a random ID for anonymous users
func generateID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 4)
	for i := range b {
		b[i] = charset[time.Now().UnixNano()%int64(len(charset))]
		time.Sleep(time.Nanosecond)
	}
	return string(b)
}

// ============================================
// Main Application
// ============================================

func main() {
	// Initialize storage (use Redis if available, otherwise memory)
	var store MessageStore
	
	// Try to connect to Redis, fallback to memory store
	redisStore := NewRedisStore("localhost:6379", 100)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	
	if _, err := redisStore.client.Ping(ctx).Result(); err == nil {
		log.Println("Connected to Redis for message storage")
		store = redisStore
	} else {
		log.Println("Redis not available, using in-memory storage")
		store = NewMemoryStore(100)
	}
	
	// Create chatroom
	chatRoom := NewChatRoom(store)
	go chatRoom.Run()
	
	// Setup Gin router
	r := gin.Default()
	
	// Serve static files
	r.Static("/static", "./static")
	r.GET("/", func(c *gin.Context) {
		c.File("./static/index.html")
	})
	
	// WebSocket endpoint
	r.GET("/ws", chatRoom.HandleWebSocket)
	
	// API endpoints
	r.GET("/api/users", func(c *gin.Context) {
		users, _ := store.GetUsers(c.Request.Context())
		c.JSON(200, gin.H{"users": users})
	})
	
	r.GET("/api/messages", func(c *gin.Context) {
		messages, _ := store.GetRecentMessages(c.Request.Context(), 50)
		c.JSON(200, gin.H{"messages": messages})
	})
	
	// Start server
	log.Println("🚀 Chatroom server starting on :8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}
