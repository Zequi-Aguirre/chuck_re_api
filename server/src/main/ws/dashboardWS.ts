import { WebSocketServer } from 'ws';
import type { Server } from 'http';

let dashboardClients: Set<any> = new Set();

export function setupDashboardWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/dashboard/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws) => {
    dashboardClients.add(ws);
    ws.on('close', () => dashboardClients.delete(ws));
  });
}

export function broadcastMarkdown(content: string, file = 'live.md') {
  const payload = JSON.stringify({ file, content });
  dashboardClients.forEach(ws => ws.readyState === 1 && ws.send(payload));
}
