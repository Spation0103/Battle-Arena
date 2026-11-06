import { decodeServerMessage, type ServerMessage } from '../shared/protocol';

export interface NetHandlers {
  onOpen(): void;
  onClose(reason: string): void;
  onMessage(msg: ServerMessage): void;
}

/**
 * Thin WebSocket wrapper. `lagMs` (from ?lag=150) simulates round-trip latency
 * by delaying every packet by lagMs/2 in each direction – handy for seeing what
 * client-side prediction actually buys you.
 */
export class Net {
  private ws: WebSocket;

  constructor(
    private readonly h: NetHandlers,
    private readonly lagMs = 0,
  ) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => h.onOpen();
    this.ws.onclose = (e) => h.onClose(e.reason || `код ${e.code}`);
    this.ws.onmessage = (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer);
      const deliver = () => {
        try {
          const msg = decodeServerMessage(data);
          if (msg) h.onMessage(msg);
        } catch {
          /* truncated / corrupt packet: ignore */
        }
      };
      if (this.lagMs > 0) setTimeout(deliver, this.lagMs / 2);
      else deliver();
    };
  }

  send(data: Uint8Array): void {
    const go = () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    };
    if (this.lagMs > 0) setTimeout(go, this.lagMs / 2);
    else go();
  }

  close(): void {
    this.ws.close();
  }
}
