import { wins } from './op.ts';

/** То, что видит сервер: непрозрачный слот, открытая метка и шифротекст. */
export interface Envelope<P = string> {
  readonly slot: string;
  readonly hlc: string;
  readonly payload: P;
}

export interface StoredEnvelope<P = string> extends Envelope<P> {
  readonly seq: number;
}

export interface PullResult<P = string> {
  readonly envelopes: StoredEnvelope<P>[];
  /** Курсор для следующего запроса. */
  readonly cursor: number;
  /** Есть ли ещё конверты после этой страницы. */
  readonly more: boolean;
}

/**
 * Эталонные правила сервера для одного пространства.
 *
 * - Для каждого слота хранится только конверт с наибольшей меткой (сжатие).
 * - Принятый конверт получает новый seq, старый конверт слота удаляется.
 * - Конверт с меткой не больше хранимой отбрасывается: повторная отправка безопасна.
 * - Клиент забирает конверты с seq больше своего курсора.
 */
export class MemoryRelay<P = string> {
  private readonly bySlot = new Map<string, StoredEnvelope<P>>();
  /** seq → конверт; Map хранит порядок вставки, а seq растёт, значит порядок по seq. */
  private readonly log = new Map<number, StoredEnvelope<P>>();
  private seq = 0;

  /** Принять пачку конвертов. Возвращает число принятых. */
  push(envelopes: readonly Envelope<P>[]): number {
    let accepted = 0;
    for (const env of envelopes) {
      const existing = this.bySlot.get(env.slot);
      if (!wins(env.hlc, existing?.hlc)) continue;
      if (existing) this.log.delete(existing.seq);
      const stored: StoredEnvelope<P> = { slot: env.slot, hlc: env.hlc, payload: env.payload, seq: ++this.seq };
      this.bySlot.set(env.slot, stored);
      this.log.set(stored.seq, stored);
      accepted++;
    }
    return accepted;
  }

  pull(since: number, limit = 500): PullResult<P> {
    const envelopes: StoredEnvelope<P>[] = [];
    let more = false;
    for (const env of this.log.values()) {
      if (env.seq <= since) continue;
      if (envelopes.length === limit) {
        more = true;
        break;
      }
      envelopes.push(env);
    }
    const cursor = envelopes.length > 0 ? envelopes[envelopes.length - 1]!.seq : since;
    return { envelopes, cursor, more };
  }

  /** Текущее состояние: слот → (метка, данные), для сравнения в тестах. */
  dump(): Array<[string, string, P]> {
    return [...this.bySlot.values()]
      .map((e): [string, string, P] => [e.slot, e.hlc, e.payload])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}
