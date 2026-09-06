/**
 * Фон, окрашенный обложкой и пульсирующий под музыку.
 *
 * Слой `.song-bg` живёт под всем контентом и управляется четырьмя CSS-переменными:
 *   --song-c1/c2/c3  доминирующие цвета обложки (src/palette.js)
 *   --song-energy    0..1, энергия низких частот прямо сейчас
 *   --song-opacity   общая видимость слоя
 *
 * Энергия берётся из AnalyserNode по полосе 20–200 Гц. Пульсация намеренно
 * вялая: экспоненциальное сглаживание + ограничение шага яркости, чтобы это
 * читалось как дыхание, а не как стробоскоп. При prefers-reduced-motion
 * пульсация выключается совсем — остаётся статичный градиент.
 */

/** Полоса низких частот, по которой считаем «бит». */
const BASS_LO_HZ = 20;
const BASS_HI_HZ = 200;

/** Сглаживание: доля нового значения на кадр. Меньше — плавнее. */
const ATTACK = 0.28;  // рост
const RELEASE = 0.08; // спад — медленнее, чтобы бит «повисал»

/** Максимальное изменение энергии за кадр. Жёсткий предохранитель от мигания. */
const MAX_DELTA = 0.09;

/** Видимость слоя, когда играет трек. */
const ACTIVE_OPACITY = 0.55;

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Pulse {
  /** @param {HTMLElement} node слой .song-bg */
  constructor(node) {
    this.node = node;
    this.raf = 0;
    this.energy = 0;
    this.analyser = null;
    this.data = null;
    this.root = document.documentElement;
  }

  /** Красит фон в цвета обложки. colors = null → возврат к нейтральному. */
  setColors(colors) {
    const s = this.root.style;
    if (!colors || colors.length === 0) {
      s.setProperty('--song-opacity', '0');
      // Цвета не сбрасываем сразу: пусть слой сначала плавно погаснет,
      // иначе на переходе мелькнёт скачок оттенка.
      return;
    }
    s.setProperty('--song-c1', colors[0]);
    s.setProperty('--song-c2', colors[1] || colors[0]);
    s.setProperty('--song-c3', colors[2] || colors[1] || colors[0]);
    s.setProperty('--song-opacity', String(ACTIVE_OPACITY));
  }

  /** Плавно возвращает фон к нейтральному состоянию. */
  clear() {
    this.stop();
    this.root.style.setProperty('--song-opacity', '0');
    this.root.style.setProperty('--song-energy', '0');
    this.energy = 0;
  }

  /**
   * Запускает пульсацию по анализатору.
   * @param {AnalyserNode} analyser
   */
  start(analyser) {
    this.stop();
    if (!analyser || reduceMotion()) {
      // Без движения — просто ровный градиент.
      this.root.style.setProperty('--song-energy', '0.35');
      return;
    }
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);

    const sampleRate = analyser.context.sampleRate;
    const binHz = sampleRate / analyser.fftSize;
    const lo = Math.max(1, Math.floor(BASS_LO_HZ / binHz));
    const hi = Math.min(this.data.length - 1, Math.ceil(BASS_HI_HZ / binHz));

    const tick = () => {
      this.analyser.getByteFrequencyData(this.data);
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += this.data[i];
      const raw = sum / ((hi - lo + 1) * 255); // 0..1

      const coef = raw > this.energy ? ATTACK : RELEASE;
      let next = this.energy + (raw - this.energy) * coef;
      // Предохранитель: даже при резком скачке в данных яркость меняется мягко.
      const delta = next - this.energy;
      if (Math.abs(delta) > MAX_DELTA) next = this.energy + Math.sign(delta) * MAX_DELTA;

      this.energy = Math.max(0, Math.min(1, next));
      this.root.style.setProperty('--song-energy', this.energy.toFixed(3));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
