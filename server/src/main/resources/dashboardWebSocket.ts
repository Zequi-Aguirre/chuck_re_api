import { WebSocketServer } from 'ws';
import fs from 'fs';

const wss = new WebSocketServer({ noServer: true });
const triggerFile = '/tmp/dashboard_ws_trigger';

wss.on('connection', (_ws) => {
  console.log('[WebSocket] Client connected');
});

// Watch for changes to trigger file
fs.watchFile(triggerFile, { interval: 500 }, () => {
  console.log('[WebSocket] Layout trigger received');
  for (const client of wss.clients) {
    console.log('[WebSocket] Sending refresh message to client');
    if (client.readyState === 1) {
      console.log('[WebSocket] Client is ready');
      client.send('__refresh__');
    }
  }
});

export default wss;
