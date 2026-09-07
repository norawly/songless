/**
 * Музыка на стартовом экране.
 *
 * Играют настоящие песни из каталога — поп, R&B, ретро и патриотика: спокойные
 * жанры, под которые можно читать экран. Не рэп и не андеграунд: они требуют
 * внимания, а это фон.
 *
 * Раньше здесь был синтезированный пад. Он никого не нарушал, но звучал как
 * гудение, а не как музыка. Настоящие превью уже лежат в каталоге, играются с
 * CDN Apple и ничего не стоят: тот же источник, что и в самой игре.
 *
 * Что важно в поведении:
 *   — играет только на стартовом экране и только с разрешения (кнопка звука
 *     в шапке помнит отказ);
 *   — тише игры вдвое: это фон, а не прослушивание;
 *   — треки сменяются с перекрёстным затуханием, без пауз и щелчков;
 *   — сыгранное в фоне НЕ попадает в партию: услышать ответ до раунда было бы
 *     подсказкой, поэтому id отыгранного отдаётся наружу через usedIds.
 *
 * Автозапуск невозможен до жеста пользователя (политика браузеров), поэтому
 * музыка заводится по первому касанию страницы.
 */

const KEY = 'olensiz:ambient';

/** Жанры, которые годятся в фон. */
const GENRES = ['pop', 'rnb', 'retro', 'patriotic'];

/** Сколько играть один трек, прежде чем уйти в следующий. */
const SEGMENT_S = 24;

/** Длительность перекрёстного затухания между треками. */
const CROSSFADE_S = 2.5;

/** Громкость фона относительно общей. */
const LEVEL = 0.45;

export function ambientAllowed() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function rememberAmbient(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* приватный режим */
  }
}

export class Ambient {
  /** @param {import('./audio.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.catalog = null;
    this.queue = [];
    this.playing = false;
    this.timer = 0;
    /** @type {{source: AudioBufferSourceNode, gain: GainNode}|null} */
    this.node = null;
    /** Что уже звучало в фоне — партия эти треки не берёт. */
    this.usedIds = new Set();
  }

  /** Каталог приходит позже самого объекта — игра грузит его асинхронно. */
  setCatalog(catalog) {
    this.catalog = catalog;
    this.queue = [];
  }

  /** Спокойные треки семейного рейтинга, вперемешку. */
  _refill() {
    if (!this.catalog) return;
    const pool = this.catalog.tracks.filter((t) =>
      t.age === 'family' && (t.genres || []).some((g) => GENRES.includes(g)));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.queue = pool.slice(0, 40);
  }

  _next() {
    if (this.queue.length === 0) this._refill();
    return this.queue.pop() || null;
  }

  async start() {
    if (this.playing) return;
    this.playing = true;
    this._cycle();
  }

  /** Один трек: завести, дать ему отыграть отрезок, уйти в следующий. */
  async _cycle() {
    if (!this.playing) return;

    const track = this._next();
    if (!track) {
      this.playing = false;
      return;
    }

    let buf;
    try {
      buf = await this.engine.load(track, { timeoutMs: 12000 });
    } catch {
      // Не загрузился — молча берём следующий, фон не повод для ошибки.
      if (this.playing) this._cycle();
      return;
    }
    if (!this.playing) return;

    const ctx = this.engine.ensureContext();
    const dest = this.engine.busIn;
    if (!ctx || !dest) return;
    await this.engine.resumeIfNeeded();

    const offset = Math.min(this.engine.startOffsetOf(track), Math.max(0, buf.duration - 5));
    const dur = Math.min(SEGMENT_S, Math.max(4, buf.duration - offset));

    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    source.connect(gain).connect(dest);

    const now = ctx.currentTime + 0.02;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(LEVEL, now + CROSSFADE_S);
    gain.gain.setValueAtTime(LEVEL, now + dur - CROSSFADE_S);
    gain.gain.linearRampToValueAtTime(0.0001, now + dur);
    source.start(now, offset);
    try {
      source.stop(now + dur + 0.05);
    } catch {
      /* реализация без stop(when) — доиграет гейном */
    }

    this._fadeOutPrevious();
    this.node = { source, gain };
    this.usedIds.add(track.id);

    // Следующий заводим чуть раньше конца — затухания накладываются, паузы нет.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._cycle(), Math.max(2000, (dur - CROSSFADE_S) * 1000));
  }

  _fadeOutPrevious() {
    const prev = this.node;
    if (!prev || !this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;
    const g = prev.gain.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + CROSSFADE_S);
      prev.source.stop(now + CROSSFADE_S + 0.1);
    } catch {
      /* уже кончился */
    }
  }

  /** Уводит фон в тишину. */
  stop(fadeS = 1.2) {
    if (!this.playing && !this.node) return;
    this.playing = false;
    clearTimeout(this.timer);
    this.timer = 0;

    const ctx = this.engine.ctx;
    const cur = this.node;
    this.node = null;
    if (!ctx || !cur) return;
    const now = ctx.currentTime;
    try {
      cur.gain.gain.cancelScheduledValues(now);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, now);
      cur.gain.gain.linearRampToValueAtTime(0.0001, now + fadeS);
      cur.source.stop(now + fadeS + 0.1);
    } catch {
      /* уже остановлен */
    }
  }
}
