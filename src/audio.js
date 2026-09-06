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
      this.analyser.smoothingTimeConstant = 0.75;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
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
   * @param {number}  [opts.fadeInMs]
   * @param {function} [opts.onEnd]
   */
  async play(track, durationMs, opts = {}) {
    this.stop();
    const buf = await this.load(track);
    const ctx = this.ensureContext();

    const offset = opts.fromZero ? 0 : this.startOffsetOf(track);
    const available = Math.max(0, buf.duration - offset);
    const durS = durationMs == null ? available : Math.min(durationMs / 1000, available);

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

    source.start(now, offset, durS);
    this.current = { source, gain, trackId: track.id };

    if (opts.onEnd) {
      source.onended = () => {
        if (this.current && this.current.source === source) this.current = null;
        opts.onEnd();
      };
    }
    return { offset, durationMs: durS * 1000 };
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
