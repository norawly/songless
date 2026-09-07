/**
 * Музыка на стартовом экране.
 *
 * Играют настоящие песни из каталога — те же, во что человек собрался играть:
 * выбрал «ретро и 18+» — фоном идёт ретро и 18+. Пока ничего не выбрано,
 * звучат спокойные жанры (поп, R&B, ретро, патриотика): под них можно читать
 * экран, а рэп и андеграунд требуют внимания.
 *
 * Раньше здесь был синтезированный пад. Он никого не нарушал, но звучал как
 * гудение, а не как музыка. Настоящие превью уже лежат в каталоге, играются с
 * CDN Apple и ничего не стоят: тот же источник, что и в самой игре.
 *
 * Что важно в поведении:
 *   — играет только на стартовом экране;
 *   — заметно тише игры, а на телефоне тише вдвое против десктопа: там
 *     динамик у лица, и тот же уровень слышится громче;
 *   — треки сменяются с перекрёстным затуханием, без пауз и щелчков;
 *   — сыгранное в фоне НЕ попадает в партию: услышать ответ до раунда было бы
 *     подсказкой, поэтому id отыгранного отдаётся наружу через usedIds.
 *
 * Автозапуск невозможен до жеста пользователя (политика браузеров), поэтому
 * музыка заводится по первому касанию страницы.
 *
 * Включён ли звук вообще — решает не этот модуль: кнопка динамика в шапке
 * гасит общий узел в AudioEngine, и фон замолкает вместе со всем остальным.
 */

/**
 * Жанры по умолчанию — когда игрок не выбрал ничего своего.
 * Спокойные: под них можно читать экран.
 */
const CALM_GENRES = ['pop', 'rnb', 'retro', 'patriotic'];

/** Сколько играть один трек, прежде чем уйти в следующий. */
const SEGMENT_S = 24;

/** Переход между треками. Секунда — ровно чтобы срез превью не резал ухо. */
const CROSSFADE_S = 1.1;

/**
 * Громкость фона относительно общей. На телефоне заметно тише: там динамик у
 * лица, и тот же уровень воспринимается вдвое громче.
 */
const LEVEL_DESKTOP = 0.30;
const LEVEL_MOBILE = 0.12;
const level = () =>
  (window.matchMedia('(max-width: 760px)').matches ? LEVEL_MOBILE : LEVEL_DESKTOP);

export class Ambient {
  /** @param {import('./audio.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.catalog = null;
    this.queue = [];
    this.playing = false;
    this.timer = 0;
    this.filters = null;
    this.filtersKey = '';
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

  /**
   * Очередь под текущие фильтры игрока.
   *
   * Выбрал «ретро и 18+» — фоном играет ретро и 18+. Ничего не выбрал —
   * спокойные жанры семейного рейтинга: фон не должен требовать внимания,
   * пока человек читает стартовый экран.
   */
  _refill() {
    if (!this.catalog) return;
    const f = this.filters || {};
    const genres = (f.genres && f.genres.length) ? f.genres : CALM_GENRES;
    const age = f.age || 'family';
    const pool = this.catalog.tracks.filter((t) => {
      if (age === 'family' && t.age !== 'family') return false;
      if (age === '18plus' && t.age !== '18plus') return false;
      return (t.genres || []).some((g) => genres.includes(g));
    });
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

  /**
   * @param {{genres?: string[], age?: string}} [filters] выбор игрока на
   *   стартовом экране: фон играет ровно то, во что человек собрался играть.
   */
  async start(filters = null) {
    const key = filters ? `${(filters.genres || []).join('+')}|${filters.age}` : '';
    if (this.playing && key === this.filtersKey) return;
    // Фильтры сменились — очередь пересобираем, текущий трек доигрывает и
    // уходит в затухание сам.
    if (key !== this.filtersKey) {
      this.filters = filters;
      this.filtersKey = key;
      this.queue = [];
    }
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
    const vol = level();
    gain.gain.linearRampToValueAtTime(vol, now + CROSSFADE_S);
    gain.gain.setValueAtTime(vol, now + dur - CROSSFADE_S);
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
