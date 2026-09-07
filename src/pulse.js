/**
 * Живой фон. Два режима, и переключаются они по смыслу экрана.
 *
 *   'glow'  — кислотное свечение снизу. Играет, пока песня ЗАГАДАНА: на
 *             стартовом экране и весь раунд. Работает как эквалайзер:
 *             громче — выше и ярче, тише — ниже и глуше. Цвет обложки тут
 *             нельзя показывать даже намёком, это была бы подсказка.
 *   'cover' — цвета обложки: три пятна на орбитах под цепочкой SVG-фильтров
 *             (смешение по шуму, квантование, смягчение краёв). Включается
 *             ровно там, где обложка уже открыта, — на карточке ответа и на
 *             финальном экране.
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

/** Насколько быстро поле перетекает в тишине и насколько разгоняется на бите. */
const BASE_SPEED = 0.13;   // рад/с — движение есть всегда
const BEAT_SPEED = 0.95;   // добавка при полном бите

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
    this.phase = 0;
    this.last = 0;
    this.mode = 'glow';
    /** Множители характера трека (src/mood.js) — только для режима обложки. */
    this.speed = 1;
    this.radius = 1;

    this._buildLayers();
  }

  /**
   * Оба набора слоёв строятся сразу и живут постоянно: показывается тот,
   * что соответствует режиму. Строить их на лету значило бы получать рывок
   * ровно в тот момент, когда открывается ответ.
   */
  _buildLayers() {
    if (!this.node || this.node.childElementCount) return;

    // Кислотное свечение снизу.
    for (const cls of ['song-glow', 'song-glow song-glow--air']) {
      const el = document.createElement('i');
      el.className = cls;
      this.node.appendChild(el);
    }

    // Цвета обложки: обёртка нужна затем, что цепочка SVG-фильтров вешается
    // на неё одну и не должна трогать кислотное свечение.
    const cover = document.createElement('i');
    cover.className = 'song-cover';
    const coverGlow = document.createElement('i');
    coverGlow.className = 'song-cover__glow';
    cover.appendChild(coverGlow);

    this.blobs = [];
    for (let i = 1; i <= 3; i++) {
      const blob = document.createElement('i');
      blob.className = `song-bg__blob song-bg__blob--${i}`;
      cover.appendChild(blob);
      this.blobs.push(blob);
    }
    this.node.appendChild(cover);

    // Вуаль поверх цветного фона. Без неё окрашенный обложкой фон побеждал
    // текст: на светлом пятне подпись исполнителя переставала читаться.
    // Она темнее всего там, где живёт контент, и растворяется к краям.
    // Кислотного свечения не касается — там душить нечего.
    const veil = document.createElement('i');
    veil.className = 'song-veil';
    this.node.appendChild(veil);

    this.node.dataset.mode = this.mode;
  }

  /**
   * Переключает режим фона.
   * @param {'glow'|'cover'} mode
   */
  setMode(mode) {
    this.mode = mode === 'cover' ? 'cover' : 'glow';
    if (this.node) this.node.dataset.mode = this.mode;
  }

  /**
   * Красит фон цветами обложки. Порядок важен: первый цвет — самый частый на
   * картинке, и пятно под него самое большое.
   *
   * @param {Array<{css:string, share:number}>|string[]|null} colors
   */
  setColors(colors) {
    if (!colors || colors.length === 0) return;
    const s = this.root.style;
    const list = colors.map((c) =>
      (typeof c === 'string' ? { css: c, share: 1 / colors.length } : c));

    for (let i = 0; i < 3; i++) {
      const c = list[Math.min(i, list.length - 1)];
      s.setProperty(`--song-c${i + 1}`, c.css);
      // Доля цвета управляет размером пятна: чего на обложке больше, то и
      // занимает больше экрана. 0.42 — минимум, чтобы третий цвет не исчезал.
      const size = 0.42 + Math.min(1, c.share * 2.2) * 0.62;
      s.setProperty(`--song-s${i + 1}`, size.toFixed(3));
    }
  }

  /** Характер трека: скорость и размах орбит зависят от жанра. */
  setMood(mood) {
    this.speed = mood?.speed ?? 1;
    this.radius = mood?.radius ?? 1;
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

      if (this.mode === 'cover') {
        const B = this.bands;
        // В режиме обложки каждое пятно отвечает за свою полосу.
        s.setProperty('--song-b1', B.bass.norm.toFixed(3));
        s.setProperty('--song-b2', B.mid.norm.toFixed(3));
        s.setProperty('--song-b3', B.air.norm.toFixed(3));
        // Чем сильнее удар, тем быстрее ход по орбите.
        this.phase += dt * (BASE_SPEED + this.beat * BEAT_SPEED) * this.speed;
        this._move();
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * Пятна не блуждают, а ходят по орбитам.
   *
   * У каждого свой круг, свой радиус и своя сторона вращения: первое и третье
   * идут по часовой, второе — против. Общая угловая скорость одна и зависит
   * от удара. Поэтому движение читается как ход по кругу под музыку, а не как
   * случайное всплывание точек. На удар орбиты слегка расходятся наружу.
   */
  _move() {
    if (!this.blobs) return;
    const p = this.phase;
    const push = 1 + this.beat * 0.22;
    const B = this.bands;
    const g1 = 1 + B.bass.norm * 0.14 + this.beat * 0.06;
    const g2 = 1 + B.mid.norm * 0.12;
    const g3 = 1 + B.air.norm * 0.16;

    const orbit = (el, angle, rx, ry, rot, sc) => {
      const x = Math.cos(angle) * rx * push * this.radius;
      const y = Math.sin(angle) * ry * push * this.radius;
      el.style.transform =
        `translate3d(${x.toFixed(2)}%, ${y.toFixed(2)}%, 0) ` +
        `rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    };

    orbit(this.blobs[0], p, 22, 18, p * 9, g1);
    orbit(this.blobs[1], -p * 0.78 + 2.1, 25, 20, -p * 7, g2 * 0.96);
    orbit(this.blobs[2], p * 0.61 + 4.2, 20, 24, p * 5, g3 * 1.05);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.analyser = null;
  }
}
