/**
 * Аудио-движок.
 *
 * Превью играются прямо с CDN Apple (audio-ssl.itunes.apple.com), который
 * отдаёт `access-control-allow-origin: *`. Это позволяет не просто играть файл,
 * а получить ArrayBuffer и разобрать его через Web Audio API — отсюда и
 * детектор тишины, и частотный анализ для пульсации фона.
 *
 * Итерация 2:
 * — ВСЕ пять треков раунда декодируются ДО старта партии (раньше загрузка
 *   начиналась в момент раунда, и первое нажатие «Ойнату» давало тишину);
 * — не загрузившийся трек молча подменяется запасным из того же тира;
 * — цепочка воспроизведения проходит через AnalyserNode: по нему пульсирует
 *   фон под музыку (src/pulse.js).
 */

import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ */
/* Параметры детектора тишины                                          */
/* ------------------------------------------------------------------ */

/** Окно анализа RMS. */
const WINDOW_MS = 10;

/** Порог «здесь есть звук»: −40 dBFS = амплитуда 0.01. */
const THRESHOLD_DBFS = -40;
const THRESHOLD_RMS = Math.pow(10, THRESHOLD_DBFS / 20);

/** Сколько подряд окон должны превышать порог, чтобы это был звук, а не щелчок. */
const SUSTAIN_MS = 50;
const SUSTAIN_WINDOWS = SUSTAIN_MS / WINDOW_MS; // 5

/** Сколько секунд после startOffset смотрим, чтобы понять «это райзер?». */
const RISER_PROBE_S = 2;

/**
 * Насколько тусклее должно быть начало по сравнению с телом трека, чтобы
 * счесть его райзером. Сравнение относительное, а не с константой: ВЧ меряется
 * через первую разность сигнала, и для синуса 1 кГц при 48 кГц это отношение
 * и так всего ≈0.13 — любая фиксированная планка либо ловит всё, либо ничего.
 */
const RISER_BRIGHTNESS_RATIO = 0.6;

const ONSET_SEARCH_S = 8;
const ONSET_MAX_SHIFT_S = 4;
const ONSET_LOUDNESS_FACTOR = 1.5;
const ONSET_BACKOFF_MS = 20;

/** Самая длинная ступень — столько секунд должно остаться после offset. */
const LONGEST_STEP_S = 16;

/* ------------------------------------------------------------------ */

function loadOffsetCache() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.OFFSET_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveOffsetCache(cache) {
  try {
    localStorage.setItem(CONFIG.OFFSET_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* приватный режим / переполнение — не повод ронять игру */
  }
}

const VOLUME_KEY = 'olensiz:volume';

/**
 * Громкость по умолчанию — треть шкалы.
 *
 * Человек заходит на сайт, и первое, что он слышит, — фоновая музыка. Громко
 * это пугает, а не приглашает; треть даёт слышимый, но фоновый уровень, и
 * дальше он сам решает.
 */
const DEFAULT_VOLUME = 0.35;

const MUTE_KEY = 'olensiz:muted';

function loadMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const v = Number(raw);
    // Пустое значение — не ноль: раньше отсутствующая запись превращалась в
    // Number(null) === 0, и звук стартовал на минимуме.
    if (raw === null || raw === '' || !Number.isFinite(v)) return DEFAULT_VOLUME;
    return v >= 0 && v <= 1 ? v : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function saveVolume(v) {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* приватный режим */
  }
}

function avg(arr, from, to) {
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return s / (to - from);
}

/**
 * Считает startOffset по декодированному буферу.
 *
 * Шаг 1. RMS окнами по 10 мс: ищем первый момент, где уровень стабильно
 *        (≥50 мс подряд) выше −40 dBFS. Это и есть требование ТЗ.
 * Шаг 2. Эвристика райзера: если начало заметно глуше остального превью
 *        того же трека, сдвигаем точку к первому перкуссионному онсету.
 *
 * @returns {{ offset: number, reason: string }} offset в секундах
 */
export function detectStartOffset(buffer) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const win = Math.max(1, Math.round((WINDOW_MS / 1000) * sr));
  const count = Math.floor(ch.length / win);
  if (count < SUSTAIN_WINDOWS) return { offset: 0, reason: 'too-short' };

  const rms = new Float32Array(count);
  const hf = new Float32Array(count); // «яркость» через первую разность

  for (let w = 0; w < count; w++) {
    const s = w * win;
    let sum = 0;
    let dsum = 0;
    for (let i = 0; i < win; i++) {
      const x = ch[s + i];
      sum += x * x;
      const d = x - (s + i > 0 ? ch[s + i - 1] : 0);
      dsum += d * d;
    }
    rms[w] = Math.sqrt(sum / win);
    hf[w] = Math.sqrt(dsum / win);
  }

  // --- Шаг 1: первое устойчивое превышение порога ---
  let start = -1;
  let run = 0;
  for (let w = 0; w < count; w++) {
    if (rms[w] > THRESHOLD_RMS) {
      run++;
      if (run >= SUSTAIN_WINDOWS) {
        start = w - SUSTAIN_WINDOWS + 1;
        break;
      }
    } else run = 0;
  }
  if (start < 0) return { offset: 0, reason: 'no-signal-found' };

  let reason = start === 0 ? 'loud-from-zero' : 'silence-trimmed';
  let offsetWin = start;

  // --- Шаг 2: эвристика райзера ---
  const brightness = (from, to) => {
    let r = 0;
    let h = 0;
    for (let w = from; w < to; w++) {
      r += rms[w];
      h += hf[w];
    }
    return r > 0 ? h / r : 0;
  };

  const probeWins = Math.round((RISER_PROBE_S * 1000) / WINDOW_MS);
  const headEnd = Math.min(count, start + probeWins);
  const head = brightness(start, headEnd);
  const body = brightness(headEnd, count);
  const comparable = count - headEnd > probeWins;

  if (comparable && body > 0 && head < RISER_BRIGHTNESS_RATIO * body) {
    const searchEnd = Math.min(count, start + Math.round((ONSET_SEARCH_S * 1000) / WINDOW_MS));
    const maxShiftWins = Math.round((ONSET_MAX_SHIFT_S * 1000) / WINDOW_MS);
    const flux = [];
    for (let w = start + 1; w < searchEnd; w++) flux.push(Math.max(0, hf[w] - hf[w - 1]));

    if (flux.length > 10) {
      const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
      const varc = flux.reduce((a, b) => a + (b - mean) ** 2, 0) / flux.length;
      const gate = mean + 3 * Math.sqrt(varc);
      const headLoudness = avg(rms, start, headEnd);

      for (let i = 0; i < flux.length && i <= maxShiftWins; i++) {
        const w = start + 1 + i;
        // Всплеск ВЧ И реальный рост громкости — иначе это шум, а не вступление.
        if (flux[i] > gate && rms[w] > headLoudness * ONSET_LOUDNESS_FACTOR) {
          const backoff = Math.round(ONSET_BACKOFF_MS / WINDOW_MS);
          offsetWin = Math.max(start, w - backoff);
          reason = 'riser-skipped';
          break;
        }
      }
    }
  }

  let offset = (offsetWin * win) / sr;

  // Не уезжаем так далеко, чтобы 16-секундная ступень не поместилась.
  const maxOffset = Math.max(0, buffer.duration - LONGEST_STEP_S);
  if (offset > maxOffset) {
    offset = maxOffset;
    reason += '+clamped';
  }
  return { offset, reason };
}

/* ================================================================== */

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {AnalyserNode|null} */
    this.analyser = null;
    /** @type {Map<string, AudioBuffer>} */
    this.buffers = new Map();
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this.inflight = new Map();
    this.offsets = loadOffsetCache();
    /** Активный источник — одновременно звучит ровно один трек. */
    this.current = null;
    /** Общая громкость 0..1, переживает перезагрузку. */
    this.master = null;
    this.volume = loadVolume();
    /** Полная тишина. Выключает ВСЁ: и фон, и превью в раунде. */
    this.muted = loadMuted();
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      // fftSize 2048 → ~23 Гц на бин: этого хватает, чтобы выделить
      // низкие частоты 20–200 Гц отдельными бинами (при 512 весь бас
      // попадал бы в один-два бина и пульсация была бы грубой).
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      // Общая громкость сайта: один узел на всё, что звучит. Анализатор стоит
      // ПЕРЕД ним — картинка фона не должна тускнеть от того, что человек
      // сделал тише; она отражает музыку, а не настройку.
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0.0001 : this.volume;
      this.analyser.connect(this.master);
      this.master.connect(this.ctx.destination);
    }
    this.resumeIfNeeded();
    return this.ctx;
  }

  /**
   * Возвращает контекст к жизни.
   *
   * iOS усыпляет AudioContext сам: после звонка, при переключении приложений,
   * при возврате из фона. Состояние при этом бывает не только 'suspended', но
   * и нестандартное 'interrupted' (только Safari). Пока контекст спит,
   * source.start() отрабатывает молча — узел играет в тишину, и это ровно тот
   * симптом «первый раунд звучал, дальше нет».
   *
   * Поэтому будим контекст на КАЖДОМ жесте и перед каждым воспроизведением, а
   * не один раз при старте.
   */
  resumeIfNeeded() {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') return Promise.resolve(true);
    return ctx.resume().then(() => ctx.state === 'running').catch(() => false);
  }

  /**
   * Беззвучный «разблокирующий» щелчок. На iOS контекст считается живым
   * только после того, как через него хоть раз что-то проиграли внутри
   * пользовательского жеста.
   */
  unlock() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* не получилось — не страшно */
    }
  }

  /**
   * Общая громкость. Меняется плавно: скачок гейна слышен щелчком.
   * @param {number} v 0..1
   */
  setVolume(v) {
    const val = Math.max(0, Math.min(1, Number(v) || 0));
    this.volume = val;
    saveVolume(val);
    // Двинули ползунок — значит, звук нужен: снимаем тишину.
    if (val > 0) this.muted = false;
    this._applyGain();
  }

  /**
   * Тишина на весь сайт.
   *
   * Кнопка звука раньше выключала только фоновую музыку стартового экрана, и
   * во время раунда от неё ничего не менялось — превью продолжало играть.
   * Теперь она гасит общий узел, через который проходит ВЕСЬ звук.
   */
  setMuted(on) {
    this.muted = Boolean(on);
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* приватный режим */
    }
    this._applyGain();
  }

  _applyGain() {
    if (!this.master || !this.ctx) return;
    const now = this.ctx.currentTime;
    const target = this.muted ? 0.0001 : Math.max(0.0001, this.volume);
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + 0.12);
  }

  /** Куда подключать посторонние источники (фоновая музыка стартового экрана). */
  get busIn() {
    this.ensureContext();
    return this.analyser;
  }

  /** Загружает и декодирует превью. Повторные вызовы бесплатны. */
  async load(track, { timeoutMs } = {}) {
    if (this.buffers.has(track.id)) return this.buffers.get(track.id);
    if (this.inflight.has(track.id)) return this.inflight.get(track.id);

    const p = (async () => {
      const ctx = this.ensureContext();
      if (!ctx) throw new Error('no-web-audio');

      const ctrl = new AbortController();
      const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let raw;
      try {
        const res = await fetch(track.preview, { mode: 'cors', signal: ctrl.signal });
        if (!res.ok) throw new Error(`preview HTTP ${res.status}`);
        raw = await res.arrayBuffer();
      } finally {
        if (timer) clearTimeout(timer);
      }

      const buf = await ctx.decodeAudioData(raw);
      this.buffers.set(track.id, buf);

      if (this.offsets[track.id] === undefined) {
        const { offset, reason } = detectStartOffset(buf);
        this.offsets[track.id] = Number(offset.toFixed(3));
        saveOffsetCache(this.offsets);
        if (window.__OLENSIZ_DEBUG) {
          console.info(`[offset] ${track.artist} — ${track.title}: ${offset.toFixed(3)}s (${reason})`);
        }
      }
      return buf;
    })();

    this.inflight.set(track.id, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(track.id);
    }
  }

  /**
   * Готовит партию целиком: декодирует все пять треков до её старта.
   * Не загрузившийся трек молча подменяется запасным того же уровня.
   *
   * @param {object[]} picked      по одному треку на раунд
   * @param {object[][]} spares    запасные того же уровня
   * @param {(done:number,total:number)=>void} onProgress
   * @returns {Promise<{tracks: object[], replaced: number}>}
   */
  async preloadGame(picked, spares, onProgress) {
    this.ensureContext();
    const total = picked.length;
    let done = 0;
    let replaced = 0;
    const bump = () => onProgress?.(++done, total);

    const resolveOne = async (main, alts) => {
      const queue = [main, ...(alts || [])];
      for (const track of queue) {
        try {
          await this.load(track, { timeoutMs: CONFIG.TRACK_LOAD_TIMEOUT_MS });
          if (track !== main) replaced++;
          bump();
          return track;
        } catch (err) {
          if (window.__OLENSIZ_DEBUG) {
            console.warn(`[preload] ${track.artist} — ${track.title}: ${err.message}`);
          }
        }
      }
      // Все варианты уровня отказали — отдаём исходный, раунд покажет ошибку.
      bump();
      return main;
    };

    const tracks = await Promise.all(picked.map((t, i) => resolveOne(t, spares?.[i])));
    return { tracks, replaced };
  }

  /**
   * Откуда начинать фрагмент.
   *
   * Ручная точка старта из data/overrides.json (локальный редактор, блок J)
   * ВСЕГДА главнее автоматического детектора: человек слышал трек, а детектор
   * только считал RMS.
   */
  startOffsetOf(track) {
    if (Number.isFinite(track.startOffset)) return Math.max(0, track.startOffset);
    return this.offsets[track.id] ?? 0;
  }

  stop(fadeMs = 0) {
    if (!this.current) return;
    const { source, gain } = this.current;
    const ctx = this.ctx;
    this.current = null;
    try {
      if (fadeMs > 0 && ctx) {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.0001, now + fadeMs / 1000);
        source.stop(now + fadeMs / 1000 + 0.01);
      } else {
        source.stop();
      }
    } catch {
      /* уже остановлен */
    }
  }

  /**
   * Играет фрагмент трека.
   * @param {object} track
   * @param {number|null} durationMs  длительность ступени; null = до конца превью
   * @param {object} [opts]
   * @param {boolean} [opts.fromZero]  играть с начала файла, а не от startOffset
   * @param {number}  [opts.fromMs]    сдвиг ВНУТРИ фрагмента: с какой его
   *   секунды начать. Ступень при этом не удлиняется — конец там же, где был.
   * @param {number}  [opts.fadeInMs]
   * @param {function} [opts.onEnd]
   */
  async play(track, durationMs, opts = {}) {
    this.stop();
    // Контекст будим ПЕРВЫМ делом и дожидаемся: если он спит, планировщик
    // примет узел, но звука не будет.
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== 'running') await this.resumeIfNeeded();
    const buf = await this.load(track);

    const fromS = Math.max(0, (opts.fromMs || 0) / 1000);
    const offset = (opts.fromZero ? 0 : this.startOffsetOf(track)) + fromS;
    const available = Math.max(0, buf.duration - offset);
    const durS = durationMs == null
      ? available
      : Math.max(0.2, Math.min(durationMs / 1000 - fromS, available));

    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    // Через анализатор — чтобы фон мог пульсировать под эту же музыку.
    source.connect(gain).connect(this.analyser);

    const now = ctx.currentTime + 0.005;
    // Микро-фейды убирают щелчок среза, но не размывают край ступени.
    const fadeIn = Math.min((opts.fadeInMs ?? 4) / 1000, durS / 4);
    const fadeOut = Math.min(0.004, durS / 4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + fadeIn);
    gain.gain.setValueAtTime(1, now + Math.max(fadeIn, durS - fadeOut));
    gain.gain.linearRampToValueAtTime(0.0001, now + durS);

    // ВАЖНО: третий аргумент start() (duration) здесь не передаётся намеренно.
    // Он планирует жёсткую остановку, которую потом уже нельзя отодвинуть, и
    // продление ступени (extendTo) молча не работало: звук обрывался на
    // старой границе. Конец фрагмента задаём отдельным stop(), его можно
    // перенести на ходу.
    source.start(now, offset);
    try {
      source.stop(now + durS + 0.02);
    } catch {
      /* реализация без stop(when) — фрагмент закончит гейн */
    }
    // Сессия помнит, когда началась и когда должна кончиться: ступень можно
    // продлить прямо на ходу, не начиная фрагмент заново (см. extendTo).
    this.current = {
      source, gain, trackId: track.id,
      startTime: now, endTime: now + durS,
      // basis — сколько фрагмента осталось позади, когда его завели с
      // середины. Всё, что снаружи спрашивает «сколько сыграно», должно
      // получать позицию в ступени, а не в этом запуске.
      basis: fromS,
      offset, maxTime: now + Math.max(0, buf.duration - offset),
    };

    if (opts.onEnd) {
      source.onended = () => {
        if (this.current && this.current.source === source) this.current = null;
        opts.onEnd();
      };
    }
    return { offset, durationMs: durS * 1000 };
  }

  /**
   * Продлевает УЖЕ ИДУЩИЙ фрагмент до новой длительности, не начиная заново.
   *
   * Это поведение «Өткізу» из блока: игрок нажал пропуск на четвёртой секунде —
   * песня не откатывается назад, она продолжает играть и теперь доиграет до
   * шести. Нажал ещё раз, не дослушав, — доиграет до десяти.
   *
   * @returns {boolean} удалось ли продлить (иначе вызывающий стартует заново)
   */
  extendTo(trackId, totalMs) {
    const c = this.current;
    if (!c || c.trackId !== trackId || !this.ctx) return false;
    const now = this.ctx.currentTime;
    if (now >= c.endTime) return false; // фрагмент уже кончился

    const newEnd = Math.min(c.startTime + totalMs / 1000 - (c.basis || 0), c.maxTime);
    if (newEnd <= c.endTime) return true; // короче не делаем, просто продолжаем

    const fadeOut = 0.004;
    const g = c.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setValueAtTime(1, Math.max(now, newEnd - fadeOut));
    g.linearRampToValueAtTime(0.0001, newEnd);
    try {
      c.source.stop(newEnd + 0.01);
    } catch {
      /* источник мог уже завершиться — тогда вызывающий стартует заново */
    }
    c.endTime = newEnd;
    return true;
  }

  /** Сколько секунд играет текущая сессия, или null. */
  elapsedOf(trackId) {
    const c = this.current;
    if (!c || c.trackId !== trackId || !this.ctx) return null;
    return Math.max(0, (c.basis || 0) + this.ctx.currentTime - c.startTime);
  }

  /** Звучит ли фрагмент этого трека прямо сейчас. */
  isLive(trackId) {
    const c = this.current;
    return Boolean(c && c.trackId === trackId && this.ctx && this.ctx.currentTime < c.endTime);
  }

  /** Полное превью с начала файла — для карточки результата и финала. */
  playFull(track, opts = {}) {
    return this.play(track, null, { fromZero: true, fadeInMs: 40, ...opts });
  }

  isPlaying(trackId) {
    return !!this.current && this.current.trackId === trackId;
  }

  /** Готов ли трек к мгновенному воспроизведению. */
  isReady(trackId) {
    return this.buffers.has(trackId);
  }
}
