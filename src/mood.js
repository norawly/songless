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
  },
  underground: {
    levels: 5, mix: 55, freq: 0.014, sat: 0.85, contrast: 1.55, soften: 1.0,
    speed: 1.45, radius: 1.20,
  },
  rock: {
    levels: 7, mix: 45, freq: 0.009, sat: 1.20, contrast: 1.35, soften: 1.6,
    speed: 1.30, radius: 1.10,
  },

  // Яркие. Лучи из центра, насыщенный свет.
  toi: {
    levels: 12, mix: 35, freq: 0.006, sat: 1.40, contrast: 1.18, soften: 2.2,
    speed: 1.20, radius: 1.10,
  },
  qpop: {
    levels: 10, mix: 40, freq: 0.007, sat: 1.50, contrast: 1.22, soften: 2.0,
    speed: 1.25, radius: 1.10,
  },
  pop: {
    levels: 14, mix: 30, freq: 0.005, sat: 1.25, contrast: 1.10, soften: 2.6,
    speed: 1.00, radius: 1.00,
  },
  retro: {
    levels: 10, mix: 30, freq: 0.006, sat: 1.30, contrast: 1.14, soften: 2.8,
    speed: 0.85, radius: 1.00,
  },

  // Мягкие. Ступеней не видно, широкие ореолы, медленный ход.
  rnb: {
    levels: 26, mix: 18, freq: 0.0035, sat: 1.10, contrast: 1.00, soften: 5.0,
    speed: 0.80, radius: 0.95,
  },
  indie: {
    levels: 16, mix: 26, freq: 0.0050, sat: 1.05, contrast: 1.04, soften: 3.4,
    speed: 0.90, radius: 1.05,
  },
  folk: {
    levels: 22, mix: 16, freq: 0.0030, sat: 1.15, contrast: 1.00, soften: 4.6,
    speed: 0.75, radius: 0.90,
  },
  patriotic: {
    levels: 18, mix: 20, freq: 0.0040, sat: 1.20, contrast: 1.04, soften: 3.6,
    speed: 0.80, radius: 0.95,
  },
};

const DEFAULT = PROFILES.pop;
const KEYS = Object.keys(DEFAULT);

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
}
