/**
 * Test Script for Chatroom
 * Run: node test.js
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const URL = `ws://localhost:${PORT}/ws?nickname=TestBot`;

console.log('🧪 Testing Chatroom Server...\n');

// Test 1: Connect and send message
const ws = new WebSocket(URL);

ws.on('open', () => {
    console.log('✅ Connected to server');
    
    // Send a test message
    console.log('📤 Sending test message...');
    ws.send('Hello from TestBot!');
    
    // Wait a bit then close
    setTimeout(() => {
        console.log('📤 Sending another message...');
        ws.send('This is a second test message!');
    }, 1000);
    
    setTimeout(() => {
        console.log('\n✅ Test complete! Closing connection...');
        ws.close();
    }, 3000);
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        console.log('📨 Received:', msg.type, '-', msg.nickname || '', msg.content || '');
    } catch (e) {
        console.log('📨 Received (raw):', data.toString());
    }
});

ws.on('close', () => {
    console.log('🔌 Disconnected');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
