/**
 * Характер фона по жанру трека.
 *
 * У каждой категории свой набор ручек — от жёсткого рэпа с грубым квантованием
 * и высоким контрастом до джаза и фолка, где растеризации нет вовсе и всё
 * максимально мягко. Ручки числовые, поэтому у трека с несколькими тегами они
 * просто усредняются: «рэп + R&B» даёт промежуточный характер сам собой,
 * без отдельной ветки в коде.
 *
 * Что делает каждая ручка:
 *   levels    — сколько уровней цвета оставляем. Мало = грубые ступени,
 *               много (20+) = квантование не видно вовсе.
 *   mix       — насколько сильно цвета затекают друг в друга (смещение по шуму).
 *   freq      — крупность шума: мелкий даёт рваную фактуру, крупный — плавные
 *               разводы.
 *   sat       — насыщенность после смешения.
 *   contrast  — контраст. Выше — резче переходы, жёстче картинка.
 *   soften    — размытие ПОСЛЕ квантования: смягчает края ступеней.
 *   speed     — множитель скорости орбит.
 *   radius    — множитель радиуса орбит.
 */

const PROFILES = {
  // Жёсткие. Полосы эквалайзера, режущий свет, мало уровней цвета.
  rap: {
    levels: 6, mix: 40, freq: 0.010, sat: 1.15, contrast: 1.40, soften: 1.4,
    speed: 1.35, radius: 1.10,
    pattern: 'bars', blend: 'hard-light', period: 190, waveOp: 0.50, waveBlur: 16,
  },
  underground: {
    levels: 5, mix: 55, freq: 0.014, sat: 0.85, contrast: 1.55, soften: 1.0,
    speed: 1.45, radius: 1.20,
    pattern: 'diagonal', blend: 'hard-light', period: 150, waveOp: 0.55, waveBlur: 12,
  },
  rock: {
    levels: 7, mix: 45, freq: 0.009, sat: 1.20, contrast: 1.35, soften: 1.6,
    speed: 1.30, radius: 1.10,
    pattern: 'diagonal', blend: 'overlay', period: 230, waveOp: 0.48, waveBlur: 20,
  },

  // Яркие. Лучи из центра, насыщенный свет.
  toi: {
    levels: 12, mix: 35, freq: 0.006, sat: 1.40, contrast: 1.18, soften: 2.2,
    speed: 1.20, radius: 1.10,
    pattern: 'rays', blend: 'screen', period: 300, waveOp: 0.42, waveBlur: 26,
  },
  qpop: {
    levels: 10, mix: 40, freq: 0.007, sat: 1.50, contrast: 1.22, soften: 2.0,
    speed: 1.25, radius: 1.10,
    pattern: 'rays', blend: 'color-dodge', period: 260, waveOp: 0.34, waveBlur: 22,
  },
  pop: {
    levels: 14, mix: 30, freq: 0.005, sat: 1.25, contrast: 1.10, soften: 2.6,
    speed: 1.00, radius: 1.00,
    pattern: 'rings', blend: 'screen', period: 320, waveOp: 0.42, waveBlur: 28,
  },
  retro: {
    levels: 10, mix: 30, freq: 0.006, sat: 1.30, contrast: 1.14, soften: 2.8,
    speed: 0.85, radius: 1.00,
    pattern: 'scan', blend: 'soft-light', period: 240, waveOp: 0.55, waveBlur: 18,
  },

  // Мягкие. Ступеней не видно, широкие ореолы, медленный ход.
  rnb: {
    levels: 26, mix: 18, freq: 0.0035, sat: 1.10, contrast: 1.00, soften: 5.0,
    speed: 0.80, radius: 0.95,
    pattern: 'rings', blend: 'screen', period: 520, waveOp: 0.30, waveBlur: 46,
  },
  indie: {
    levels: 16, mix: 26, freq: 0.0050, sat: 1.05, contrast: 1.04, soften: 3.4,
    speed: 0.90, radius: 1.05,
    pattern: 'rings', blend: 'soft-light', period: 420, waveOp: 0.40, waveBlur: 34,
  },
  folk: {
    levels: 22, mix: 16, freq: 0.0030, sat: 1.15, contrast: 1.00, soften: 4.6,
    speed: 0.75, radius: 0.90,
    pattern: 'scan', blend: 'soft-light', period: 480, waveOp: 0.34, waveBlur: 42,
  },
  patriotic: {
    levels: 18, mix: 20, freq: 0.0040, sat: 1.20, contrast: 1.04, soften: 3.6,
    speed: 0.80, radius: 0.95,
    pattern: 'rings', blend: 'screen', period: 460, waveOp: 0.32, waveBlur: 38,
  },
};

/** Ручки, которые нельзя усреднить арифметически. */
const PICKED = ['pattern', 'blend'];

const DEFAULT = PROFILES.pop;
const KEYS = Object.keys(DEFAULT).filter((k) => !PICKED.includes(k));

/**
 * Характер трека. Несколько тегов — среднее по ним: жанры у трека равноправны,
 * и выделять «главный» было бы выдумкой.
 *
 * @param {{genres?: string[]}} track
 */
export function moodFor(track) {
  const list = (track?.genres || []).map((g) => PROFILES[g]).filter(Boolean);
  if (list.length === 0) return { ...DEFAULT };

  const out = {};
  for (const k of KEYS) {
    out[k] = list.reduce((sum, p) => sum + p[k], 0) / list.length;
  }
  out.levels = Math.max(4, Math.round(out.levels));

  // Рисунок и режим наложения усреднить нельзя — это не числа. Берём их у
  // самого «характерного» жанра: у того, чей контраст дальше от спокойного.
  // Так «рэп + R&B» получает полосы рэпа, но смягчённые до середины по всем
  // числовым ручкам — и это ровно то смешение, которого мы хотели.
  const lead = list.reduce((a, b) =>
    (Math.abs(b.contrast - 1) > Math.abs(a.contrast - 1) ? b : a));
  for (const k of PICKED) out[k] = lead[k];
  return out;
}

/** Значения ступеней для feFunc*: n уровней от 0 до 1. */
function tableValues(levels) {
  const n = Math.max(2, Math.min(64, levels));
  return Array.from({ length: n }, (_, i) => (i / (n - 1)).toFixed(3)).join(' ');
}

/**
 * Переставляет ручки живого SVG-фильтра под характер трека.
 * Сам фильтр объявлен в index.html — здесь только значения.
 */
export function applyFilter(mood) {
  const q = (id) => document.getElementById(id);
  const noise = q('fx-noise');
  const disp = q('fx-disp');
  const sat = q('fx-sat');
  const contrast = q('fx-contrast');
  const steps = q('fx-steps');
  const soft = q('fx-soft');
  if (!noise || !disp || !sat || !contrast || !steps || !soft) return;

  noise.setAttribute('baseFrequency', `${mood.freq.toFixed(4)} ${(mood.freq * 1.6).toFixed(4)}`);
  disp.setAttribute('scale', String(Math.round(mood.mix)));
  sat.setAttribute('values', mood.sat.toFixed(2));

  // Контраст как линейная функция: slope вокруг середины диапазона.
  const slope = mood.contrast;
  const intercept = (1 - slope) / 2;
  for (const fn of contrast.children) {
    fn.setAttribute('slope', slope.toFixed(2));
    fn.setAttribute('intercept', intercept.toFixed(3));
  }

  const table = tableValues(mood.levels);
  for (const fn of steps.children) fn.setAttribute('tableValues', table);

  soft.setAttribute('stdDeviation', mood.soften.toFixed(2));

  // Волновые слои: рисунок, режим наложения и базовый шаг между волнами.
  const bg = document.getElementById('song-bg');
  if (!bg) return;
  bg.dataset.pattern = mood.pattern;
  const st = bg.style;
  st.setProperty('--wave-blend', mood.blend);
  st.setProperty('--wave-period', `${Math.round(mood.period)}px`);
  st.setProperty('--wave-op', mood.waveOp.toFixed(2));
  st.setProperty('--wave-blur', `${Math.round(mood.waveBlur)}px`);
}
