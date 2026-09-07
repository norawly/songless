/**
 * Живой фон: зелёное свечение снизу, которое дышит под музыку.
 *
 * Раньше фон красился доминирующими цветами обложки и проходил через цепочку
 * SVG-фильтров. От этого отказались сознательно: цвет обложки спорил с
 * интерфейсом, а фильтры давали резкие границы. Теперь фон один и всегда
 * один и тот же — лаймовый градиент от нижнего края, ровно как эквалайзер:
 * громче — выше и ярче, тише — ниже и глуше. Никаких эффектов сверх этого.
 *
 * ПОРОГОВ С КОНСТАНТАМИ ЗДЕСЬ НЕТ, и скользящего среднего тоже. Спектр
 * разбит на полосы, и у каждой свои пол и пик с разной инерцией:
 *
 *   — пол идёт вниз быстро, вверх почти не идёт, поэтому громкое место не
 *     имеет права поднять планку до себя;
 *   — пик поднимается мгновенно и оседает медленно, поэтому достигнутая
 *     вершина остаётся вершиной, пока не случится выше.
 *
 * Наивное среднее вело себя ровно наоборот: оно ползло вверх вслед за
 * повторяющимся битом, догоняло его, и через пару тактов бит переставал
 * считаться битом. Здесь удар бьёт каждый раз, а припев и дроп планку
 * поднимают по-настоящему.
 *
 * При prefers-reduced-motion остаётся ровное статичное свечение.
 */

const BANDS = [
  { key: 'kick', lo: 20,   hi: 90 },    // бочка
  { key: 'bass', lo: 90,   hi: 220 },   // бас
  { key: 'body', lo: 220,  hi: 800 },   // тело барабанов, гитары
  { key: 'mid',  lo: 800,  hi: 2500 },  // основа голоса
  { key: 'air',  lo: 2500, hi: 9000 },  // воздух, тарелки, шипящие
];

/** Видимость слоя, когда звучит музыка. */
const ACTIVE_OPACITY = 1;

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Одна полоса спектра: пол, удержание пика и онсет. Подробности — в шапке
 * файла; коротко: не усредняться к пику, иначе бит растворяется в среднем.
 */
class Band {
  constructor() {
    this.floor = 1;
    this.peak = 0;
    this.prev = 0;
    this.norm = 0;
    this.hit = 0;
  }

  push(v, dt) {
    this.floor += (v - this.floor) * (v < this.floor ? 0.25 : 0.0012);
    this.peak = v > this.peak ? v : this.peak * 0.9985;

    const span = Math.max(0.03, this.peak - this.floor);
    this.norm = clamp01((v - this.floor) / span);

    const attack = clamp01((v - this.prev) / (span * 0.55));
    this.prev = v;
    this.hit = attack > this.hit ? attack : Math.max(0, this.hit - dt * 3.4);
    return this;
  }
}

export class Pulse {
  /** @param {HTMLElement} node слой .song-bg */
  constructor(node) {
    this.node = node;
    this.raf = 0;
    this.analyser = null;
    this.data = null;
    this.root = document.documentElement;

    this.bands = Object.fromEntries(BANDS.map((b) => [b.key, new Band()]));
    this.loud = new Band();

    this.beat = 0;
    this.air = 0;
    this.lift = 0;
    this.last = 0;

    this._buildLayers();
  }

  /** Два слоя свечения: нижний ведёт удар, верхний — голос. */
  _buildLayers() {
    if (!this.node || this.node.childElementCount) return;
    for (const cls of ['song-glow', 'song-glow song-glow--air']) {
      const el = document.createElement('i');
      el.className = cls;
      this.node.appendChild(el);
    }
  }

  /** Показывает слой. Цвет один и тот же всегда — он от обложки не зависит. */
  show() {
    this.root.style.setProperty('--song-opacity', String(ACTIVE_OPACITY));
    if (!this.raf) this._loop();
  }

  /** Плавно возвращает фон к покою. */
  clear() {
    this.stop();
    const s = this.root.style;
    s.setProperty('--song-opacity', '0');
    s.setProperty('--song-beat', '0');
    s.setProperty('--song-voice', '0');
    s.setProperty('--song-lift', '0');
    s.setProperty('--song-energy', '0');
    this.beat = 0;
    this.air = 0;
    this.lift = 0;
  }

  /**
   * Подключает анализатор. Полосы сбрасываются: они калибруются под
   * конкретную музыку, и от прошлой им ничего не нужно.
   * @param {AnalyserNode} analyser
   */
  start(analyser) {
    this.bands = Object.fromEntries(BANDS.map((b) => [b.key, new Band()]));
    this.loud = new Band();

    if (!analyser || reduceMotion()) {
      this.analyser = null;
      this.stop();
      this.root.style.setProperty('--song-beat', '0.28');
      this.root.style.setProperty('--song-voice', '0.28');
      this.root.style.setProperty('--song-energy', '0.28');
      return;
    }

    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const bin = (hz) => Math.max(1, Math.min(this.data.length - 1, Math.round(hz / binHz)));
    this.ranges = BANDS.map((b) => ({ key: b.key, lo: bin(b.lo), hi: bin(b.hi) }));
    this.fullRange = { lo: bin(30), hi: bin(11000) };

    if (!this.raf) this._loop();
  }

  _band({ lo, hi }) {
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.data[i];
    return sum / ((hi - lo + 1) * 255);
  }

  _loop() {
    const tick = (now) => {
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
      this.last = now;

      if (this.analyser) {
        this.analyser.getByteFrequencyData(this.data);
        for (const r of this.ranges) this.bands[r.key].push(this._band(r), dt);
        this.loud.push(this._band(this.fullRange), dt);

        const B = this.bands;
        const hit = Math.max(B.kick.hit, B.bass.hit * 0.9, B.body.hit * 0.55);
        this.beat = hit > this.beat
          ? this.beat + (hit - this.beat) * 0.45
          : Math.max(0, this.beat - dt * 1.7);

        const voice = Math.max(B.mid.norm * 0.9, B.air.norm);
        this.air += (voice - this.air) * (voice > this.air ? 0.10 : 0.05);

        this.lift += (this.loud.norm - this.lift) * 0.03;
      } else {
        this.beat = Math.max(0, this.beat - dt * 1.2);
        this.air = Math.max(0, this.air - dt * 1.2);
        this.lift = Math.max(0, this.lift - dt * 0.8);
      }

      const s = this.root.style;
      s.setProperty('--song-beat', this.beat.toFixed(3));
      s.setProperty('--song-voice', this.air.toFixed(3));
      s.setProperty('--song-lift', this.lift.toFixed(3));
      s.setProperty('--song-energy', ((this.beat + this.air) / 2).toFixed(3));

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.analyser = null;
  }
}
