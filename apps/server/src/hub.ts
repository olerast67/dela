export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Entry {
  readonly userId: string;
  readonly deviceId: string;
  readonly socket: HubSocket;
}

/** Открытые WebSocket-соединения устройств. Шлёт только сигнал «в пространстве есть новое». */
export class Hub {
  private readonly entries = new Set<Entry>();

  add(userId: string, deviceId: string, socket: HubSocket): void {
    this.entries.add({ userId, deviceId, socket });
  }

  remove(socket: HubSocket): void {
    for (const e of this.entries) if (e.socket === socket) this.entries.delete(e);
  }

  notify(userIds: readonly string[], message: unknown): void {
    const targets = new Set(userIds);
    const data = JSON.stringify(message);
    for (const e of this.entries) {
      if (!targets.has(e.userId)) continue;
      try {
        e.socket.send(data);
      } catch {
        this.entries.delete(e);
      }
    }
  }

  /** Закрыть соединения отозванного устройства. */
  closeDevice(deviceId: string): void {
    for (const e of this.entries) {
      if (e.deviceId !== deviceId) continue;
      this.entries.delete(e);
      try {
        e.socket.close(4001, 'device revoked');
      } catch {
        // соединение уже закрыто
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
