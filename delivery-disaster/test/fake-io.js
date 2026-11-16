// Minimal in-memory stand-in for Socket.IO (server + clients) so the server logic can be tested without installing it.
let nextId = 1;

export class FakeIO {
  constructor() {
    this.sockets = new Map();
    this.rooms = new Map();          // room -> Set(serverSocket)
    this.connectionHandlers = [];
  }
  on(event, fn) { if (event === 'connection') this.connectionHandlers.push(fn); }
  _deliver(room, event, payload, except = null) {
    for (const s of this.rooms.get(room) || []) if (s !== except) s._client._receive(event, payload);
  }
  to(room) {
    const self = this;
    const api = { emit: (e, p) => self._deliver(room, e, p) };
    api.volatile = api;
    return api;
  }
  // Create a connected fake client.
  connect() {
    const id = 'sock' + nextId++;
    const handlers = {};
    const client = {
      id, received: [], connected: true,
      emit(event, payload, ack) { server._handlers[event]?.(payload, ack); },
      _receive(event, payload) { this.received.push({ event, payload }); },
      last(event) { return [...this.received].reverse().find((m) => m.event === event)?.payload; },
      all(event) { return this.received.filter((m) => m.event === event).map((m) => m.payload); },
      request(event, payload) { let out; client.emit(event, payload, (r) => { out = r; }); return out; },
      disconnect(reason = 'transport close') {
        client.connected = false;
        server._handlers.disconnect?.(reason);
        for (const set of io.rooms.values()) set.delete(server);
        io.sockets.delete(id);
      },
    };
    const io = this;
    const server = {
      id, data: {}, _handlers: handlers, _client: client,
      on: (e, fn) => { handlers[e] = fn; },
      join: (room) => { if (!io.rooms.has(room)) io.rooms.set(room, new Set()); io.rooms.get(room).add(server); },
      leave: (room) => { io.rooms.get(room)?.delete(server); },
      to: (room) => ({ emit: (e, p) => io._deliver(room, e, p, server) }),
    };
    this.sockets.set(id, server);
    for (const fn of this.connectionHandlers) fn(server);
    return client;
  }
}
