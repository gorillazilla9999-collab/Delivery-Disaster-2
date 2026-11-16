// Express serves the game files; Socket.IO handles multiplayer. One Render Web Service does both.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { attachGameServer } from './game-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;     // Render provides PORT
const HOST = '0.0.0.0';                            // required on Render
const MAX_PLAYERS = Math.min(12, Math.max(1, parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 12));
const isProd = process.env.NODE_ENV === 'production';

// CORS_ORIGIN: "*" (default) or a comma-separated list, e.g. "https://me.github.io,https://example.com".
// Only matters if the frontend is hosted somewhere other than this service.
const corsEnv = (process.env.CORS_ORIGIN || '*').trim();
const corsOrigin = corsEnv === '*' ? '*' : corsEnv.split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');

// Health check for Render (also handy for uptime pings).
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()), ...game.rooms.stats() });
});

// Only the game's own folders are public - server code and package.json are not exposed.
const staticOpts = { maxAge: isProd ? '5m' : 0 };
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
for (const dir of ['css', 'js', 'assets']) app.use('/' + dir, express.static(path.join(ROOT, dir), staticOpts));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5,
});
const game = attachGameServer(io, { maxPlayers: MAX_PLAYERS, log: (m) => console.log(m) });

server.listen(PORT, HOST, () => {
  console.log(`Delivery Disaster listening on http://${HOST}:${PORT} (max ${MAX_PLAYERS} players/room)`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  game.stop();
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
