/**
 * Живой фон: цвета обложки, реагирующие на музыку.
 *
 * Три слоя, у каждого своя работа:
 *
 *   1. СВЕЧЕНИЕ (.song-glow) — сам тёмный фон. Загорается на БИТ.
 *   2. ПЯТНА (.song-bg__blob) — цветные градиенты из обложки. Реагируют на
 *      ВЕРХНИЕ частоты: голос, гитары, тарелки. Быстро и резко.
 *
 * Белой вспышки здесь больше нет намеренно: она мигала в такт с пятнами, и
 * весь фон вспыхивал целиком. Свет на удар даёт только свечение, и он
 * окрашен цветом обложки, а не белый.
 *
 * Движение пятен считает JS, а не CSS-анимация: скорость должна зависеть от
 * бита («громче — быстрее»), а менять `animation-duration` на лету значит
 * дёргать фазу. Здесь фаза копится сама, и её приращение зависит от энергии.
 *
 * ПОРОГОВ С КОНСТАНТАМИ ЗДЕСЬ НЕТ, и скользящего среднего тоже. Спектр
 * разбит на пять полос, и у каждой свои пол и пик с разной инерцией:
 *
 *   — пол идёт вниз быстро, вверх почти не идёт, поэтому громкое место не
 *     имеет права поднять планку до себя;
 *   — пик поднимается мгновенно и оседает медленно, поэтому достигнутая
 *     вершина остаётся вершиной, пока не случится выше.
 *
 * Наивное среднее вело себя ровно наоборот: оно ползло вверх вслед за
 * повторяющимся битом, догоняло его, и через пару тактов бит переставал
 * считаться битом. Здесь удар бьёт каждый раз. При этом припев и дроп планку
 * поднимают (стало громче по-настоящему), а затихание опускает.
 *
 * Каждая полоса ведёт свой элемент фона: низ — удар и свет, середина и воздух
 * — цветные пятна. Отдельная широкая полоса даёт --song-lift: насколько
 * сейчас громче обычного, то есть где припев.
 *
 * При prefers-reduced-motion не работает ничего из этого — остаётся ровный
 * статичный градиент.
 */

/**
 * Полосы спектра. Каждая живёт своей жизнью: у каждой свой пол, свой пик и
 * свой онсет, и каждая ведёт свой элемент фона.
 */
const BANDS = [
  { key: 'kick', lo: 20,   hi: 90 },    // бочка
  { key: 'bass', lo: 90,   hi: 220 },   // бас
  { key: 'body', lo: 220,  hi: 800 },   // тело барабанов, гитары
  { key: 'mid',  lo: 800,  hi: 2500 },  // основа голоса
  { key: 'air',  lo: 2500, hi: 9000 },  // воздух, тарелки, шипящие
];

/** Насколько быстро поле перетекает в тишине и насколько разгоняется на бите. */
const BASE_SPEED = 0.13;   // рад/с — движение есть всегда
const BEAT_SPEED = 0.95;   // добавка при полном бите

/** Видимость слоя, когда играет трек. */
const ACTIVE_OPACITY = 0.85;

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Одна полоса спектра.
 *
 * Главная идея — НЕ УСРЕДНЯТЬСЯ К ПИКУ. Наивное скользящее среднее ползёт
 * вверх вслед за повторяющимся битом, планка догоняет удар, и через пару
 * тактов бит перестаёт считаться битом вовсе. Поэтому здесь две границы
 * с разной инерцией:
 *
 *   floor — «тихий уровень». Вниз идёт быстро, вверх почти не идёт: громкое
 *           место не имеет права поднять пол. Это и есть «не усредняйся к
 *           высокой точке».
 *   peak  — удержание максимума. Пришло громче — планка мгновенно поднялась.
 *           Не приходит — она оседает медленно, за несколько секунд. Значит
 *           достигнутая вершина остаётся вершиной, пока не случится выше.
 *
 * Вместе это даёт ровно то, что нужно: припев и дроп поднимают планку (стало
 * громче — верх поехал вверх), затихание её опускает, а повторяющийся удар
 * бьёт каждый раз, а не растворяется в среднем.
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
    // Пол: вниз быстро, вверх еле-еле.
    this.floor += (v - this.floor) * (v < this.floor ? 0.25 : 0.0012);
    // Пик: вверх мгновенно, вниз медленным оседанием (≈4 с до половины).
    this.peak = v > this.peak ? v : this.peak * 0.9985;

    const span = Math.max(0.03, this.peak - this.floor);
    this.norm = clamp01((v - this.floor) / span);

    // Онсет: прирост относительно того же размаха. Он не зависит от того,
    // насколько громко играет вообще, поэтому тихий трек бьёт так же чётко.
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
    this.loud = new Band();   // весь спектр — для распознавания припева и дропа

    this.beat = 0;
    this.air = 0;
    this.lift = 0;
    this.phase = 0;
    this.last = 0;
    /** Множители характера трека (src/mood.js). */
    this.speed = 1;
    this.radius = 1;

    this._buildLayers();
  }

  /**
   * Свечение, три пятна и вспышка. Строятся здесь, а не в разметке: это чисто
   * визуальный механизм, странице о нём знать незачем.
   */
  _buildLayers() {
    if (!this.node || this.node.childElementCount) return;

    const glow = document.createElement('i');
    glow.className = 'song-glow';
    this.node.appendChild(glow);

    this.blobs = [];
    for (let i = 1; i <= 3; i++) {
      const blob = document.createElement('i');
      blob.className = `song-bg__blob song-bg__blob--${i}`;
      this.node.appendChild(blob);
      this.blobs.push(blob);
    }

    // Волновые слои поверх поля. Волны никогда не исчезают — на удар растёт
    // расстояние между ними, и они расходятся, а не мигают.
    this.waves = [];
    for (let i = 1; i <= 3; i++) {
      const w = document.createElement('i');
      w.className = `song-wave song-wave--${i}`;
      this.node.appendChild(w);
      this.waves.push(w);
    }

  }

  /**
   * Красит фон цветами обложки. Порядок важен: первый цвет — самый частый на
   * картинке, и пятно под него самое большое.
   *
   * @param {Array<{css:string, share:number}>|string[]|null} colors
   */
  setColors(colors) {
    const s = this.root.style;
    if (!colors || colors.length === 0) {
      s.setProperty('--song-opacity', '0');
      // Цвета не сбрасываем сразу: пусть слой сначала плавно погаснет,
      // иначе на переходе мелькнёт скачок оттенка.
      return;
    }

    const list = colors.map((c) =>
      (typeof c === 'string' ? { css: c, share: 1 / colors.length } : c));

    for (let i = 0; i < 3; i++) {
      const c = list[Math.min(i, list.length - 1)];
      s.setProperty(`--song-c${i + 1}`, c.css);
      // Доля цвета управляет размером пятна: чего на обложке больше, то и
      // занимает больше экрана. 0.35 — минимум, чтобы третий цвет не исчезал.
      const size = 0.42 + Math.min(1, c.share * 2.2) * 0.62;
      s.setProperty(`--song-s${i + 1}`, size.toFixed(3));
    }
    s.setProperty('--song-opacity', String(ACTIVE_OPACITY));

    if (!this.raf) this._loop();
  }

  /** Характер трека: скорость и размах орбит зависят от жанра. */
  setMood(mood) {
    this.speed = mood?.speed ?? 1;
    this.radius = mood?.radius ?? 1;
  }

  /** Плавно возвращает фон к нейтральному состоянию. */
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
  }

  /**
   * Подключает анализатор. Диапазоны и скользящее среднее сбрасываются:
   * они калибруются под конкретный трек, и от прошлого им ничего не нужно.
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
        // Удар — низ. Берём онсет бочки и баса: он бьёт каждый раз, потому что
        // считается от размаха полосы, а не от её среднего.
        const hit = Math.max(B.kick.hit, B.bass.hit * 0.9, B.body.hit * 0.55);
        this.beat = hit > this.beat
          ? this.beat + (hit - this.beat) * 0.45
          : Math.max(0, this.beat - dt * 1.7);

        // Голос — середина и воздух, плавно.
        const voice = Math.max(B.mid.norm * 0.9, B.air.norm);
        this.air += (voice - this.air) * (voice > this.air ? 0.10 : 0.05);

        // Подъём: насколько сейчас громче обычного. Припев и дроп поднимают
        // его к единице, куплет держит около нуля.
        this.lift += (this.loud.norm - this.lift) * 0.03;
      } else {
        // Тишина: всё гаснет, но движение остаётся — фон живой всегда.
        this.beat = Math.max(0, this.beat - dt * 1.2);
        this.air = Math.max(0, this.air - dt * 1.2);
        this.lift = Math.max(0, this.lift - dt * 0.8);
      }

      const s = this.root.style;
      const B = this.bands;
      s.setProperty('--song-beat', this.beat.toFixed(3));
      s.setProperty('--song-voice', this.air.toFixed(3));
      s.setProperty('--song-lift', this.lift.toFixed(3));
      s.setProperty('--song-energy', ((this.beat + this.air) / 2).toFixed(3));
      // Каждое пятно отвечает за свою полосу.
      s.setProperty('--song-b1', B.bass.norm.toFixed(3));
      s.setProperty('--song-b2', B.mid.norm.toFixed(3));
      s.setProperty('--song-b3', B.air.norm.toFixed(3));

      // Расстояние между волнами растёт на удар: волны расходятся, а не гаснут.
      this.root.style.setProperty('--wave-p', (1 + this.beat * 0.55).toFixed(3));

      // Чем сильнее удар, тем быстрее движение.
      this.phase += dt * (BASE_SPEED + this.beat * BEAT_SPEED) * this.speed;
      this._move();

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * Пятна не блуждают, а ходят по орбитам.
   *
   * У каждого свой круг, свой радиус и своя сторона вращения: первое и третье
   * идут по часовой, второе — против. Общая угловая скорость одна и зависит от
   * удара: сильнее бит — быстрее оборот. Поэтому движение читается как ход по
   * кругу под музыку, а не как случайное всплывание точек в разных местах.
   *
   * На удар орбиты ещё и слегка расходятся наружу — поле «раскрывается».
   */
  _move() {
    if (!this.blobs) return;
    const p = this.phase;
    const push = 1 + this.beat * 0.22;              // расхождение на удар
    const B = this.bands;
    // Каждое пятно дышит своей полосой, а не общей энергией.
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

    // По часовой, против часовой, по часовой — с разными периодами, чтобы
    // взаимное расположение всё время менялось.
    orbit(this.blobs[0], p, 22, 18, p * 9, g1);
    orbit(this.blobs[1], -p * 0.78 + 2.1, 25, 20, -p * 7, g2 * 0.96);
    orbit(this.blobs[2], p * 0.61 + 4.2, 20, 24, p * 5, g3 * 1.05);

    // Волновые слои медленно ползут и поворачиваются в разные стороны —
    // рисунок наложения всё время меняется, но ни один слой не пропадает.
    if (!this.waves) return;
    const wave = (el, angle, r, rot) => {
      el.style.transform =
        `translate3d(${(Math.cos(angle) * r).toFixed(2)}%, ` +
        `${(Math.sin(angle) * r).toFixed(2)}%, 0) rotate(${rot.toFixed(2)}deg)`;
    };
    wave(this.waves[0], p * 0.5, 7, p * 4);
    wave(this.waves[1], -p * 0.37 + 1.4, 9, -p * 3);
    wave(this.waves[2], p * 0.28 + 3.1, 6, p * 2);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
    this.analyser = null;
  }
}
