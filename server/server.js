import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { DeviceStateManager } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TOTAL_DEVICES = process.env.TOTAL_DEVICES ? parseInt(process.env.TOTAL_DEVICES, 10) : 42;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const stateManager = new DeviceStateManager(TOTAL_DEVICES);

// Enable JSON middleware and static files
app.use(express.json());
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    // Prevent caching for sw.js and manifest
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// API endpoints
app.get('/api/info', (req, res) => {
  const ips = getLocalIpAddresses();
  res.json({
    status: 'ok',
    version: '1.0.0',
    port: PORT,
    totalDevices: TOTAL_DEVICES,
    serverTime: Date.now(),
    ips,
    clientUrls: ips.map(ip => `http://${ip}:${PORT}`),
    adminUrls: ips.map(ip => `http://${ip}:${PORT}/admin.html`)
  });
});

app.get('/api/state', (req, res) => {
  res.json(stateManager.getAdminSnapshot());
});

// Helper: Broadcast to all connected admins
function broadcastToAdmins() {
  const admins = stateManager.getAdminSockets();
  if (admins.length === 0) return;

  const snapshot = JSON.stringify(stateManager.getAdminSnapshot());
  for (const adminWs of admins) {
    if (adminWs.readyState === 1) { // OPEN
      adminWs.send(snapshot);
    }
  }
}

// Helper: Broadcast command to clients
function broadcastToClients(commandPayload, targetId = 'all') {
  const message = JSON.stringify(commandPayload);
  
  if (targetId === 'all') {
    const clients = stateManager.getConnectedClientSockets();
    for (const { ws } of clients) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  } else {
    const id = parseInt(targetId, 10);
    const ws = stateManager.getClientSocket(id);
    if (ws && ws.readyState === 1) {
      ws.send(message);
    }
  }
}

let socketSequence = 1;

wss.on('connection', (ws, req) => {
  const socketId = `sock_${socketSequence++}_${Date.now()}`;
  let clientRole = null;
  let clientDeviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }

    // High Precision NTP Clock Sync (handle fast, zero unnecessary overhead)
    if (msg.type === 'sync_ping') {
      const serverReceiveTime = Date.now();
      const serverSendTime = serverReceiveTime;
      ws.send(JSON.stringify({
        type: 'sync_pong',
        clientSendTime: msg.clientSendTime,
        serverReceiveTime,
        serverSendTime
      }));
      return;
    }

    // Registration
    if (msg.type === 'register') {
      clientRole = msg.role; // 'client' | 'admin'

      if (msg.role === 'admin') {
        stateManager.registerAdmin(ws);
        ws.send(JSON.stringify({
          type: 'registered',
          role: 'admin',
          serverTime: Date.now()
        }));
        // Send immediate snapshot to this admin
        ws.send(JSON.stringify(stateManager.getAdminSnapshot()));
        return;
      }

      if (msg.role === 'client') {
        const slot = stateManager.registerClient(ws, socketId, msg);
        clientDeviceId = slot ? slot.id : null;

        ws.send(JSON.stringify({
          type: 'registered',
          role: 'client',
          id: clientDeviceId,
          name: slot ? slot.name : null,
          serverTime: Date.now(),
          globalPlayback: {
            ...stateManager.globalPlayback,
            currentEstimatedPosition: stateManager.getCurrentGlobalPosition()
          }
        }));

        broadcastToAdmins();
        return;
      }
    }

    // Client Telemetry
    if (msg.type === 'telemetry') {
      stateManager.updateTelemetry(socketId, msg);
      return;
    }

    // Admin Commands
    if (msg.type === 'admin_command') {
      handleAdminCommand(msg);
    }
  });

  ws.on('close', () => {
    stateManager.unregisterSocket(socketId);
    broadcastToAdmins();
  });

  ws.on('error', () => {
    stateManager.unregisterSocket(socketId);
    broadcastToAdmins();
  });
});

function handleAdminCommand(msg) {
  const now = Date.now();

  switch (msg.action) {
    case 'play': {
      const delayMs = msg.delayMs || 1200; // 1200ms lead time allows Wi-Fi delivery and hardware decoder pre-buffering
      const targetServerTime = now + delayMs;
      const startPosition = typeof msg.position === 'number' 
        ? Math.max(0, msg.position) 
        : stateManager.getCurrentGlobalPosition();

      stateManager.setPlay(targetServerTime, startPosition);

      broadcastToClients({
        type: 'command',
        action: 'play',
        targetServerTime,
        startPosition,
        syncMode: stateManager.globalPlayback.syncMode
      });
      break;
    }

    case 'retrigger': {
      const delayMs = msg.delayMs || 600;
      const targetServerTime = now + delayMs;
      stateManager.setPlay(targetServerTime, 0);

      broadcastToClients({
        type: 'command',
        action: 'retrigger',
        targetServerTime,
        startPosition: 0,
        syncMode: stateManager.globalPlayback.syncMode
      });
      break;
    }

    case 'set_sync_mode': {
      stateManager.setSyncMode(msg.mode);
      broadcastToClients({
        type: 'command',
        action: 'set_sync_mode',
        mode: stateManager.globalPlayback.syncMode
      });
      break;
    }

    case 'pause': {
      const currentPos = typeof msg.position === 'number'
        ? msg.position
        : stateManager.getCurrentGlobalPosition();

      stateManager.setPause(currentPos);

      broadcastToClients({
        type: 'command',
        action: 'pause',
        position: currentPos
      });
      break;
    }

    case 'seek': {
      const delayMs = msg.delayMs || 600;
      const targetServerTime = now + delayMs;
      const position = Math.max(0, Number(msg.position) || 0);

      stateManager.setSeek(position, targetServerTime);

      broadcastToClients({
        type: 'command',
        action: 'seek',
        targetServerTime,
        position,
        autoPlay: stateManager.globalPlayback.status === 'playing',
        syncMode: stateManager.globalPlayback.syncMode
      });
      break;
    }

    case 'stop': {
      stateManager.setStop();

      broadcastToClients({
        type: 'command',
        action: 'stop'
      });
      break;
    }

    case 'loop': {
      stateManager.setLoop(msg.loop);
      broadcastToClients({
        type: 'command',
        action: 'loop',
        loop: stateManager.globalPlayback.loop
      });
      break;
    }

    case 'identify': {
      const targetId = msg.targetId || 'all';
      const durationMs = msg.durationMs || 5000;

      broadcastToClients({
        type: 'command',
        action: 'identify',
        durationMs
      }, targetId);
      break;
    }

    case 'reload': {
      const targetId = msg.targetId || 'all';
      broadcastToClients({
        type: 'command',
        action: 'reload'
      }, targetId);
      break;
    }

    case 'blackout': {
      const targetId = msg.targetId || 'all';
      broadcastToClients({
        type: 'command',
        action: 'blackout',
        enabled: !!msg.enabled
      }, targetId);
      break;
    }

    case 'check_arm': {
      broadcastToClients({
        type: 'command',
        action: 'check_arm'
      });
      break;
    }
  }

  broadcastToAdmins();
}

// Periodic Loop: Admin state updates & Loop Boundary Auto-Restart
const adminBroadcastInterval = setInterval(() => {
  // Check if we need to schedule a synchronized loop restart
  const loopBoundary = stateManager.checkLoopBoundary(1200);
  if (loopBoundary) {
    broadcastToClients({
      type: 'command',
      action: 'loop_restart',
      targetServerTime: loopBoundary.targetServerTime,
      cycleIndex: loopBoundary.nextCycleIndex,
      syncMode: loopBoundary.syncMode
    });
  }

  broadcastToAdmins();
}, 200);
adminBroadcastInterval.unref();

// Stale connection cleaner (every 5 seconds)
const staleCleanupInterval = setInterval(() => {
  const disconnected = stateManager.cleanStaleConnections(7000);
  if (disconnected.length > 0) {
    broadcastToAdmins();
  }
}, 5000);
staleCleanupInterval.unref();

// Helper to list local IP addresses
function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal (127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results.length > 0 ? results : ['127.0.0.1'];
}

// Start Server
const serverReady = new Promise((resolve) => {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIpAddresses();
    console.log('='.repeat(65));
    console.log(`🚀 iPad Synchronized Video Player Server v1.0.0`);
    console.log(`   Configured for ${TOTAL_DEVICES} iPad devices`);
    console.log('='.repeat(65));
    console.log(`📱 Client URL for iPads:`);
    ips.forEach(ip => {
      console.log(`   👉 http://${ip}:${PORT}`);
    });
    console.log(`\n🎛️  Admin Dashboard URL:`);
    ips.forEach(ip => {
      console.log(`   👉 http://${ip}:${PORT}/admin.html`);
    });
    console.log('='.repeat(65));
    resolve({ server, PORT });
  });
});

function closeServer() {
  return new Promise((resolve) => {
    clearInterval(adminBroadcastInterval);
    clearInterval(staleCleanupInterval);
    wss.close(() => {
      server.close(() => {
        resolve();
      });
    });
  });
}

export { app, server, wss, stateManager, serverReady, closeServer };
