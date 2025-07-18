# PeerPigeon WebSocket Server

A local WebSocket server for PeerPigeon development and testing.

## Features

- WebSocket-based peer signaling
- XOR distance-based peer discovery
- WebRTC signaling message routing
- In-memory peer storage
- Real-time peer announcements
- Graceful connection handling

## Quick Start

### Option 1: Using npm package (Recommended)

```bash
# Install PeerPigeon
npm install peerpigeon

# Start the server using npm scripts
npm start

# Or with custom configuration
PORT=8080 HOST=0.0.0.0 npm start
```

### Option 2: From source

```bash
# Clone the repository
git clone https://github.com/draeder/peerpigeon.git
cd peerpigeon

# Start the server directly
npm start
```

### Option 3: Programmatic usage (Recommended for applications)

```javascript
import { PeerPigeonServer } from 'peerpigeon';

// Create and configure server
const server = new PeerPigeonServer({
    port: 3000,
    maxConnections: 500
});

// Start server
await server.start();

// Listen for events
server.on('peerConnected', ({ peerId, totalConnections }) => {
    console.log(`New peer connected: ${peerId}`);
});
```

The server will start on `ws://localhost:3000` by default.

### 3. Connect from Browser

Update your browser application to connect to the local server:

```javascript
const mesh = new PeerPigeonMesh();
await mesh.connect('ws://localhost:3000');
```

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `HOST`: Server host (default: localhost)

### Example Usage

```bash
# Start on custom port
PORT=8080 npm start

# Start on all interfaces
HOST=0.0.0.0 npm start
```

## API

### Connection

Connect with a valid 40-character hex peer ID:

```
ws://localhost:3000?peerId=abc123def456...
```

### Message Types

#### Peer Announcement
```json
{
  "type": "announce",
  "data": { "peerId": "abc123..." }
}
```

#### WebRTC Signaling
```json
{
  "type": "offer",
  "data": { "sdp": "..." },
  "targetPeerId": "def456..."
}
```

#### Keep-Alive
```json
{
  "type": "ping",
  "data": { "timestamp": 1234567890 }
}
```

### Response Messages

#### Connection Confirmation
```json
{
  "type": "connected",
  "peerId": "abc123...",
  "timestamp": 1234567890
}
```

#### Peer Discovery
```json
{
  "type": "peer-discovered",
  "data": { "peerId": "def456..." },
  "fromPeerId": "system",
  "targetPeerId": "abc123...",
  "timestamp": 1234567890
}
```

#### Pong Response
```json
{
  "type": "pong",
  "timestamp": 1234567890,
  "originalTimestamp": 1234567885
}
```

## Testing

### Manual Testing

You can test the server using a WebSocket client:

```javascript
const ws = new WebSocket('ws://localhost:3000?peerId=1234567890abcdef1234567890abcdef12345678');

ws.onopen = () => {
    console.log('Connected');
    
    // Send announcement
    ws.send(JSON.stringify({
        type: 'announce',
        data: { peerId: '1234567890abcdef1234567890abcdef12345678' }
    }));
};

ws.onmessage = (event) => {
    console.log('Received:', JSON.parse(event.data));
};
```

### Browser Testing

1. Open `examples/browser/index.html` in multiple browser tabs
2. Update the WebSocket URL to `ws://localhost:3000`
3. Click "Connect" in each tab
4. Watch peers discover each other

## Development

### Watch Mode

For development with automatic restarts:

```bash
npm run dev
```

### Logging

The server provides detailed logging:

- ✅ Peer connections
- 📨 Message routing
- 📢 Peer announcements
- 🔌 Disconnections
- ❌ Errors

## Architecture

```
Browser Client 1    Browser Client 2    Browser Client N
       |                   |                   |
       v                   v                   v
    WebSocket           WebSocket           WebSocket
       |                   |                   |
       +-------------------+-------------------+
                           |
                    Local WebSocket Server
                           |
                    In-Memory Storage
                    (peers, connections)
```

## Troubleshooting

### Common Issues

1. **Connection Refused**: Check if server is running on correct port
2. **Invalid Peer ID**: Ensure peer ID is 40-character hex string
3. **Message Not Delivered**: Check if target peer is connected
4. **Server Won't Start**: Check if port is already in use

### Debug Commands

```bash
# Check if port is in use
lsof -i :3000

# Kill process on port
kill -9 $(lsof -t -i:3000)

# Check server logs
npm start | grep "ERROR"
```

## License

MIT - Same as PeerPigeon main project
