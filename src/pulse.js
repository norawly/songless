/**
 * Живой фон: цветные пятна, окрашенные обложкой, и реакция на бит.
 *
 * Итерация 3 — фон перестал стоять на месте. Два независимых движения:
 *
 *   1. МЕДЛЕННОЕ ТЕЧЕНИЕ. Три пятна плывут по своим траекториям и с разными
 *      периодами (19/23/29 с — взаимно простые, поэтому картинка не
 *      зацикливается на глаз). Это чистый CSS: transform-анимация идёт на
 *      композиторе и не зависит от того, играет ли музыка. Движение есть даже
 *      в тишине — как в Apple Music.
 *
 *   2. РЕАКЦИЯ НА БИТ. Энергия полосы 20–200 Гц из AnalyserNode: на пике
 *      картинка светлеет к белому, чуть расширяется и получает мягкое
 *      свечение, между битами возвращается к базовому состоянию.
 *
 * Против стробоскопа стоят три ограничителя: сглаживание самого анализатора
 * (smoothingTimeConstant 0.75), экспоненциальное сглаживание с разными
 * коэффициентами на рост и спад, и жёсткий потолок дельты за кадр.
 *
 * При prefers-reduced-motion не работает ни первое, ни второе: остаётся
 * ровный статичный градиент.
 */

/** Полоса низких частот, по которой считаем «бит». */
const BASS_LO_HZ = 20;
const BASS_HI_HZ = 200;

/** Сглаживание: доля нового значения на кадр. Меньше — плавнее. */
const ATTACK = 0.30;  // рост — быстрее, чтобы удар читался
const RELEASE = 0.07; // спад — медленнее, чтобы бит «повисал»

/** Максимальное изменение энергии за кадр. Жёсткий предохранитель от мигания. */
const MAX_DELTA = 0.085;

/**
 * Нормировка: чистая энергия баса редко доходит до 1, и без растяжки
 * пульсация была бы почти незаметной. Значения ниже NOISE считаем тишиной.
 */
const NOISE = 0.06;
const GAIN = 1.6;

/** Видимость слоя, когда играет трек. */
const ACTIVE_OPACITY = 0.62;

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
    this._buildLayers();
  }

  /**
   * Три пятна + вспышка. Строятся здесь, а не в разметке: это чисто
   * визуальный механизм, странице о нём знать незачем.
   */
  _buildLayers() {
    if (!this.node || this.node.childElementCount) return;
    for (let i = 1; i <= 3; i++) {
      const blob = document.createElement('i');
      blob.className = `song-bg__blob song-bg__blob--${i}`;
      this.node.appendChild(blob);
    }
    const flash = document.createElement('i');
    flash.className = 'song-bg__flash';
    this.node.appendChild(flash);
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
   * Запускает реакцию на бит.
   * @param {AnalyserNode} analyser
   */
  start(analyser) {
    this.stop();
    if (!analyser || reduceMotion()) {
      // Без движения — просто ровный градиент средней яркости.
      this.root.style.setProperty('--song-energy', '0.3');
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
      const level = sum / ((hi - lo + 1) * 255); // 0..1
      const raw = Math.min(1, Math.max(0, (level - NOISE) * GAIN));

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
