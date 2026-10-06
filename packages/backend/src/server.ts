import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import { encoding, decoding } from 'lib0';
import { WS_PATH, isValidRoom } from '@spatial-soundscape/common';

const PORT = Number(process.env['PORT'] ?? 3001);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  name: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<WSConn>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface WSConn {
  socket: import('ws').WebSocket;
  room: Room;
  controlledIds: Set<number>;
}

const rooms = new Map<string, Room>();
const GRACE_MS = 5 * 60_000;

function getRoom(name: string): Room {
  let room = rooms.get(name);
  if (room) {
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
    return room;
  }
  const doc = new Y.Doc();
  room = {
    name,
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    connections: new Set(),
    cleanupTimer: null,
  };
  attachRoomBroadcast(room);
  rooms.set(name, room);
  return room;
}

// One listener per room (not per connection): each update is fanned out once.
function attachRoomBroadcast(room: Room): void {
  room.doc.on('update', (update: Uint8Array, origin: unknown) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    // The originating connection already has this update.
    broadcast(room, encoding.toUint8Array(enc), origin as WSConn | null);
  });

  room.awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const conn = origin as WSConn | null;
      const changedClients = added.concat(updated, removed);
      if (conn && conn.controlledIds) {
        // Track this conn's client IDs so they can be reaped on disconnect.
        for (const id of added) conn.controlledIds.add(id);
        for (const id of removed) conn.controlledIds.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients),
      );
      broadcast(room, encoding.toUint8Array(enc), null);
    },
  );
}

function broadcast(room: Room, message: Uint8Array, except: WSConn | null): void {
  for (const c of room.connections) {
    if (c === except) continue;
    if (c.socket.readyState === c.socket.OPEN) {
      c.socket.send(message);
    }
  }
}

function setupDocSync(conn: WSConn): void {
  const { room, socket } = conn;

  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    socket.send(encoding.toUint8Array(enc));
  }

  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(awarenessStates.keys()),
      ),
    );
    socket.send(encoding.toUint8Array(enc));
  }
}

function handleMessage(conn: WSConn, data: Uint8Array): void {
  const dec = decoding.createDecoder(data);
  const enc = encoding.createEncoder();
  const type = decoding.readVarUint(dec);

  switch (type) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(dec, enc, conn.room.doc, conn);
      if (encoding.length(enc) > 1) {
        conn.socket.send(encoding.toUint8Array(enc));
      }
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        conn.room.awareness,
        decoding.readVarUint8Array(dec),
        conn,
      );
      break;
    }
    default:
      break;
  }
}

const fastify = Fastify({
  logger: {
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
  },
});

await fastify.register(websocket);

fastify.get('/health', async () => ({
  ok: true,
  rooms: rooms.size,
  uptime: process.uptime(),
}));

fastify.get('/rooms', async () => ({
  rooms: Array.from(rooms.values()).map(r => ({
    name: r.name,
    connections: r.connections.size,
    docSize: Y.encodeStateAsUpdate(r.doc).byteLength,
  })),
}));

fastify.register(async (instance) => {
  instance.get(`${WS_PATH}/:room`, { websocket: true }, (socket, req) => {
    const params = req.params as { room: string };
    const roomName = params.room;

    if (!isValidRoom(roomName)) {
      socket.close(1008, 'invalid room name');
      return;
    }

    const room = getRoom(roomName);
    const conn: WSConn = {
      socket,
      room,
      controlledIds: new Set(),
    };
    room.connections.add(conn);
    fastify.log.info(`[ws] join ${roomName} (${room.connections.size} conn)`);

    socket.on('message', (raw: Buffer) => {
      try {
        handleMessage(conn, new Uint8Array(raw));
      } catch (err) {
        fastify.log.error({ err }, 'message handler failed');
      }
    });

    socket.on('close', () => {
      room.connections.delete(conn);
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        Array.from(conn.controlledIds),
        null,
      );
      fastify.log.info(`[ws] leave ${roomName} (${room.connections.size} conn)`);

      if (room.connections.size === 0) {
        room.cleanupTimer = setTimeout(() => {
          rooms.delete(roomName);
          room.doc.destroy();
          fastify.log.info(`[ws] room ${roomName} reaped after grace period`);
        }, GRACE_MS);
      }
    });

    setupDocSync(conn);
  });
});

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`🌀 spatial-soundscape backend listening on ${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
