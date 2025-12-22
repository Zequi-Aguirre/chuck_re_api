import { WebSocketServer } from 'ws';
import { watch } from 'fs';
import path from 'path';

export function setupDashboardSocket(server: any) {
  const wss = new WebSocketServer({ server, path: '/dashboard/ws' });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] Dashboard client connected');

    const sendUpdate = () => {
      const timestamp = Date.now();
      ws.send(JSON.stringify({ type: 'update', timestamp }));
    };

    const markdownPath = path.resolve(__dirname, '../../../../client/public/dashboard/markdown-container.html');
    const watcher = watch(markdownPath, sendUpdate);

    ws.on('close', () => {
      watcher.close();
      console.log('[WebSocket] Dashboard client disconnected');
    });
  });
}
