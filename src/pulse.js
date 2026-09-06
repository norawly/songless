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
 * ПОРОГОВ С КОНСТАНТАМИ ЗДЕСЬ НЕТ. Их не может быть: у одной песни бас всё
 * время на 0.8, у другой не поднимается выше 0.2, и любая фиксированная планка
 * либо горит всегда, либо не срабатывает никогда. Вместо неё две адаптивные
 * штуки:
 *
 *   — AutoRange растягивает текущий диапазон сигнала в 0..1 и сам подстраивает
 *     границы под трек за пару секунд;
 *   — Excess сравнивает мгновенный уровень со СКОЛЬЗЯЩИМ СРЕДНИМ этого же
 *     трека, а не с константой. Поэтому «очень басистая песня» больше не
 *     превращается в равномерно горящий экран: на фоне её же громкого баса
 *     удары всё равно выделяются.
 *
 * И сам удар ищется не только в басу: параллельно считается спектральный поток
 * по всей полосе. Бочка даёт всплеск в басу, щелчок или атака гитары — в
 * потоке; берётся тот сигнал, который сильнее. Поэтому «бит» работает и там,
 * где баса почти нет.
 *
 * При prefers-reduced-motion не работает ничего из этого — остаётся ровный
 * статичный градиент.
 */

/** Полосы. Бас — удар, верх — голос и всё яркое. */
const BASS_LO_HZ = 20;
const BASS_HI_HZ = 160;
const AIR_LO_HZ = 1800;
const AIR_HI_HZ = 7000;

/** Насколько быстро поле перетекает в тишине и насколько разгоняется на бите. */
const BASE_SPEED = 0.13;   // рад/с — движение есть всегда
const BEAT_SPEED = 0.95;   // добавка при полном бите

/** Видимость слоя, когда играет трек. */
const ACTIVE_OPACITY = 0.85;

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Автоматический диапазон: держит наблюдаемые минимум и максимум и растягивает
 * сигнал между ними. Верхняя граница медленно оседает, нижняя медленно
 * поднимается — иначе один громкий всплеск задавил бы весь остальной трек.
 */
class AutoRange {
  constructor() {
    this.lo = 1;
    this.hi = 0;
  }

  push(v) {
    this.hi = v > this.hi ? v : this.hi * 0.9985 + v * 0.0015;
    this.lo = v < this.lo ? v : this.lo + (v - this.lo) * 0.0015;
    const span = Math.max(0.045, this.hi - this.lo);
    return Math.min(1, Math.max(0, (v - this.lo) / span));
  }
}

/**
 * Превышение мгновенного уровня над скользящим средним — в долях самого
 * среднего. Никаких констант-порогов: планка едет вместе с треком.
 */
class Excess {
  constructor(window = 0.055, sens = 0.85) {
    this.avg = 0;
    this.window = window;
    this.sens = sens;
  }

  push(v) {
    this.avg += (v - this.avg) * this.window;
    const e = (v - this.avg) / Math.max(0.04, this.avg * this.sens + 0.02);
    return Math.min(1, Math.max(0, e));
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

    this.fluxRange = new AutoRange();
    this.airRange = new AutoRange();
    this.bassExcess = new Excess();
    this.fluxExcess = new Excess(0.045, 0.7);
    this.airExcess = new Excess(0.08, 0.55);
    this.prev = null;

    this.beat = 0;
    this.air = 0;
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
    this.fluxRange = new AutoRange();
    this.airRange = new AutoRange();
    this.bassExcess = new Excess();
    this.fluxExcess = new Excess(0.045, 0.7);
    this.airExcess = new Excess(0.08, 0.55);
    this.prev = null;

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
    this.prev = new Uint8Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    // Полоса для спектрального потока: от низа до «воздуха», где и живут
    // перкуссия и атаки инструментов.
    this.fluxBand = [
      Math.max(1, Math.floor(40 / binHz)),
      Math.min(this.data.length - 1, Math.ceil(9000 / binHz)),
    ];
    this.bass = [
      Math.max(1, Math.floor(BASS_LO_HZ / binHz)),
      Math.min(this.data.length - 1, Math.ceil(BASS_HI_HZ / binHz)),
    ];
    this.airBand = [
      Math.max(1, Math.floor(AIR_LO_HZ / binHz)),
      Math.min(this.data.length - 1, Math.ceil(AIR_HI_HZ / binHz)),
    ];

    if (!this.raf) this._loop();
  }

  _band([lo, hi]) {
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.data[i];
    return sum / ((hi - lo + 1) * 255);
  }

  /**
   * Спектральный поток: сумма приростов спектра между кадрами.
   *
   * Это и есть «бит — не обязательно бас». Удар барабана, щелчок сэмпла, атака
   * гитары дают всплеск потока независимо от того, в какой полосе они лежат.
   * У песни без выраженного баса удары всё равно видны.
   */
  _flux() {
    const [lo, hi] = this.fluxBand;
    let sum = 0;
    for (let i = lo; i <= hi; i++) {
      const d = this.data[i] - this.prev[i];
      if (d > 0) sum += d;
      this.prev[i] = this.data[i];
    }
    return sum / ((hi - lo + 1) * 255);
  }

  _loop() {
    const tick = (now) => {
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
      this.last = now;

      if (this.analyser) {
        this.analyser.getByteFrequencyData(this.data);

        // Удар ищем двумя способами сразу и берём тот, что сильнее:
        // превышение баса над его же средним и всплеск спектрального потока.
        // Первый ловит бочку, второй — всё остальное, что «бьёт».
        const bassHit = this.bassExcess.push(this._band(this.bass));
        const flux = this._flux();
        const fluxHit = Math.max(this.fluxExcess.push(flux), this.fluxRange.push(flux) * 0.75);
        const hit = Math.min(1, Math.max(bassHit, fluxHit));
        // Приход быстрый, но не мгновенный, уход за ~600 мс: удар читается
        // как волна света, а не как вспышка лампы.
        this.beat = hit > this.beat
          ? this.beat + (hit - this.beat) * 0.35
          : Math.max(0, this.beat - dt * 1.7);

        // Верх → голос. Ровный уровень задаёт «дыхание», а всплески на слогах
        // и тарелках делают движение резким. Без второго слагаемого верх почти
        // всё время упирался в потолок и пятна переставали реагировать.
        const airRaw = this._band(this.airBand);
        const target = Math.min(1, Math.max(
          this.airRange.push(airRaw) * 0.6,
          this.airExcess.push(airRaw)
        ));
        // Плавно в обе стороны: это дыхание поля, а не мигание. Резкость
        // раньше давала стробоскопический эффект на вокале.
        this.air += (target - this.air) * (target > this.air ? 0.10 : 0.05);
      } else {
        // Тишина: всё гаснет, но движение остаётся — фон живой всегда.
        this.beat = Math.max(0, this.beat - dt * 1.2);
        this.air = Math.max(0, this.air - dt * 1.2);
      }

      const s = this.root.style;
      s.setProperty('--song-beat', this.beat.toFixed(3));
      s.setProperty('--song-voice', this.air.toFixed(3));
      s.setProperty('--song-energy', ((this.beat + this.air) / 2).toFixed(3));

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
    const grow = 1 + this.air * 0.10 + this.beat * 0.05;

    const orbit = (el, angle, rx, ry, rot, sc) => {
      const x = Math.cos(angle) * rx * push * this.radius;
      const y = Math.sin(angle) * ry * push * this.radius;
      el.style.transform =
        `translate3d(${x.toFixed(2)}%, ${y.toFixed(2)}%, 0) ` +
        `rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
    };

    // По часовой, против часовой, по часовой — с разными периодами, чтобы
    // взаимное расположение всё время менялось.
    orbit(this.blobs[0], p, 22, 18, p * 9, grow);
    orbit(this.blobs[1], -p * 0.78 + 2.1, 25, 20, -p * 7, grow * 0.96);
    orbit(this.blobs[2], p * 0.61 + 4.2, 20, 24, p * 5, grow * 1.05);

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
