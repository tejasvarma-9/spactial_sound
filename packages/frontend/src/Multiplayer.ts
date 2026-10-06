import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import { encoding, decoding } from 'lib0';
import { WS_PATH } from '@spatial-soundscape/common';
import type {
  AudioEngine,
  NodeId,
  SpatialNodeDescriptor,
  Vec3,
  Realm,
  RealmId,
  EnvironmentType,
  Portal,
  PortalId,
} from '@spatial-soundscape/engine';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface World {
  nodes: Map<NodeId, SpatialNodeDescriptor>;
  realms: Map<RealmId, Realm>;
  portals: Map<PortalId, Portal>;
  peers: Map<string, { position: Vec3; color: string }>;
  peerChats: Map<string, { text: string; at: number }>;
}

export class Multiplayer {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws: WebSocket | null = null;
  private nodesY: Y.Map<SpatialNodeDescriptor>;
  private realmsY: Y.Map<Realm>;
  private portalsY: Y.Map<Portal>;
  private envY: Y.Map<string>;
  onRealmChange?: () => void;
  onPortalChange?: () => void;
  onEnvironmentChange?: (env: EnvironmentType) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly world: World,
  ) {
    this.nodesY   = this.doc.getMap<SpatialNodeDescriptor>('nodes');
    this.realmsY  = this.doc.getMap<Realm>('realms');
    this.portalsY = this.doc.getMap<Portal>('portals');
    this.envY     = this.doc.getMap<string>('env');
    this._observeNodes();
    this._observeRealms();
    this._observePortals();
    this._observeEnvironment();
    this._observeAwareness();

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.ws) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.ws.send(encoding.toUint8Array(enc));
    });

    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'remote') return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this.ws.send(encoding.toUint8Array(enc));
    });
  }


  connect(room: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}/${room}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 3000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(enc, this.doc);
        ws.send(encoding.toUint8Array(enc));

        this.awareness.setLocalStateField('peer', {
          color: '#00f5d4',
          position: { x: 0, y: 0, z: 0 },
        });
        resolve();
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev.data as ArrayBuffer));
      ws.addEventListener('close', () => this._scheduleReconnect(room));
      ws.addEventListener('error', () => { /* close will follow */ });
    });
  }

  private _scheduleReconnect(room: string): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.connect(room).catch(() => this._scheduleReconnect(room));
    }, 2000);
  }

  /**
   * Fully tear down this instance: cancel reconnect timer, close socket,
   * remove local awareness state, destroy the y-doc. Call before creating
   * a new Multiplayer for a new room — otherwise the old connection lingers
   * and the wanderer count keeps growing.
   */
  disposed = false;
  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Remove local awareness so peers see us leave immediately.
    try { awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local'); } catch { /* noop */ }
    try { this.awareness.destroy(); } catch { /* noop */ }
    if (this.ws) {
      // Detach handlers so the pending 'close' event doesn't schedule a
      // reconnect we no longer want.
      const w = this.ws;
      this.ws = null;
      try { w.close(); } catch { /* already closed */ }
    }
    try { this.doc.destroy(); } catch { /* noop */ }
  }

  private _onMessage(data: ArrayBuffer): void {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const enc = encoding.createEncoder();
    const type = decoding.readVarUint(dec);
    switch (type) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, this.ws);
        if (encoding.length(enc) > 1 && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(encoding.toUint8Array(enc));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(dec),
          'remote',
        );
        break;
      }
    }
  }


  private _observeNodes(): void {
    this.nodesY.observe((event) => {
      event.changes.keys.forEach((change, key) => {
        const id = key as NodeId;
        if (change.action === 'add' || change.action === 'update') {
          const descriptor = this.nodesY.get(key);
          if (!descriptor) return;
          if (!this.world.nodes.has(id)) {
            this.world.nodes.set(id, descriptor);
            try { this.engine.addNode(descriptor); } catch { /* duplicate */ }
          } else {
            this.world.nodes.set(id, descriptor);
            this.engine.getNode(id)?.setPosition(descriptor.position, 80);
          }
        } else if (change.action === 'delete') {
          this.world.nodes.delete(id);
          this.engine.removeNode(id);
        }
      });
    });
  }

  private _observeRealms(): void {
    this.realmsY.observe((event) => {
      let changed = false;
      event.changes.keys.forEach((change, key) => {
        const id = key as RealmId;
        if (change.action === 'add' || change.action === 'update') {
          const realm = this.realmsY.get(key);
          if (!realm) return;
          this.world.realms.set(id, realm);
          changed = true;
        } else if (change.action === 'delete') {
          this.world.realms.delete(id);
          changed = true;
        }
      });
      if (changed) this.onRealmChange?.();
    });
  }

  private _observePortals(): void {
    this.portalsY.observe((event) => {
      let changed = false;
      event.changes.keys.forEach((change, key) => {
        const id = key as PortalId;
        if (change.action === 'add' || change.action === 'update') {
          const p = this.portalsY.get(key);
          if (!p) return;
          this.world.portals.set(id, p);
          changed = true;
        } else if (change.action === 'delete') {
          this.world.portals.delete(id);
          changed = true;
        }
      });
      if (changed) this.onPortalChange?.();
    });
  }

  broadcastPortalAdd(portal: Portal): void {
    this.doc.transact(() => this.portalsY.set(portal.id, portal));
  }
  broadcastPortalRemove(id: PortalId): void {
    this.doc.transact(() => this.portalsY.delete(id));
  }

  private _observeEnvironment(): void {
    this.envY.observe(() => {
      const env = (this.envY.get('current') as EnvironmentType | undefined) ?? 'none';
      this.onEnvironmentChange?.(env);
    });
  }

  broadcastEnvironment(env: EnvironmentType): void {
    this.doc.transact(() => this.envY.set('current', env));
  }

  private _observeAwareness(): void {
    this.awareness.on('change', () => {
      const states = this.awareness.getStates();
      const seen = new Set<string>();
      for (const [clientId, state] of states) {
        if (clientId === this.awareness.clientID) continue;
        const peer = (state as Record<string, unknown>)['peer'] as
          | { position: Vec3; color: string; chat?: { text: string; at: number } }
          | undefined;
        if (!peer) continue;
        const id = String(clientId);
        this.world.peers.set(id, peer);
        if (peer.chat && peer.chat.at + 5500 > Date.now()) {
          this.world.peerChats.set(id, peer.chat);
        } else {
          this.world.peerChats.delete(id);
        }
        seen.add(id);
      }
      for (const id of this.world.peers.keys()) {
        if (!seen.has(id)) { this.world.peers.delete(id); this.world.peerChats.delete(id); }
      }
    });
  }


  broadcastNodeAdd(descriptor: SpatialNodeDescriptor): void {
    this.doc.transact(() => this.nodesY.set(descriptor.id, descriptor));
  }

  broadcastNodeMove(id: NodeId, position: Vec3): void {
    const existing = this.nodesY.get(id);
    if (!existing) return;
    this.doc.transact(() => this.nodesY.set(id, { ...existing, position }));
  }

  broadcastNodeRemove(id: NodeId): void {
    this.doc.transact(() => this.nodesY.delete(id));
  }

  broadcastRealmAdd(realm: Realm): void {
    this.doc.transact(() => this.realmsY.set(realm.id, realm));
  }
  broadcastRealmUpdate(realm: Realm): void {
    this.doc.transact(() => this.realmsY.set(realm.id, realm));
  }
  broadcastRealmRemove(id: RealmId): void {
    this.doc.transact(() => this.realmsY.delete(id));
  }

  broadcastPosition(position: Vec3): void {
    const current = this.awareness.getLocalState() as { peer?: { color: string; chat?: unknown } } | null;
    this.awareness.setLocalStateField('peer', {
      color: current?.peer?.color ?? '#00f5d4',
      position,
      ...(current?.peer?.chat ? { chat: current.peer.chat } : {}),
    });
  }

  broadcastChat(text: string): void {
    const current = this.awareness.getLocalState() as { peer?: { color: string; position: Vec3 } } | null;
    const chat = { text: text.slice(0, 60), at: Date.now() };
    this.awareness.setLocalStateField('peer', {
      color: current?.peer?.color ?? '#00f5d4',
      position: current?.peer?.position ?? { x: 0, y: 0, z: 0 },
      chat,
    });
    setTimeout(() => {
      const cur = this.awareness.getLocalState() as { peer?: { color: string; position: Vec3 } } | null;
      this.awareness.setLocalStateField('peer', {
        color: cur?.peer?.color ?? '#00f5d4',
        position: cur?.peer?.position ?? { x: 0, y: 0, z: 0 },
      });
    }, 5500);
  }
}
