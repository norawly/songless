/**
 * Система очков. Все константы — здесь и только здесь.
 * Полный вывод формулы и примеры расчёта: SCORING.md
 *
 *   raw   = S_k + bonus(t)
 *   round = round( max(raw, FLOOR · S_k) · M )
 *
 * S_k — базовая цена ступени, t — время до ПЕРВОГО ввода после окончания
 * фрагмента, M — коэффициент режима (блок B1).
 *
 * Три правила итерации 3, ради которых формула переписана:
 *   1. Бонус ТОЛЬКО добавляется. Он не бывает отрицательным и не может
 *      уменьшить базу ступени.
 *   2. Жёсткий пол: любой верный ответ стоит минимум FLOOR от базы своей
 *      ступени. Ноль возможен только у неугаданного трека.
 *   3. Спад бонуса пологий: разница «ответил за 2 с» и «за 6 с» заметна,
 *      но не драматична.
 */

import { foldKey, trigramSim } from './normalize.js';

/* ------------------------------------------------------------------ */
/* Режимы подачи (блок B1)                                             */
/* ------------------------------------------------------------------ */

/**
 * Два режима отличаются длиной фрагментов и ценой ступеней.
 *
 * Обычный: шесть длинных ступеней, играть можно без напряжения.
 * Экспертный: шесть ступеней от двух десятых секунды и множитель 1.8 — плата
 * за то, что задача объективно тяжелее (в нём же в верхние уровни
 * подмешиваются тир 5 и андеграунд, см. catalog.js).
 *
 * Итерация 4 переставила обе лестницы. Прежние были слишком пологими: между
 * «узнал со второй секунды» и «домучил на двадцатой» разница получалась в
 * пять раз, а между обычным игроком и человеком, который знает каталог
 * наизусть, — почти никакой. Потолок упирался в 11 250, и первые же
 * несколько партий подводили к нему вплотную.
 *
 * Теперь шаг между ступенями круче (≈0.62 вместо 0.72), а бонус за узнавание
 * поднят с 25% до 50% — то есть цена ранней догадки выросла вдвое. Потолок
 * экспертного режима — 20 250 за партию, и добраться до него означает
 * угадать все пять песен на первой ступени почти мгновенно.
 *
 * Инвариант «ступень важнее скорости» держится в обоих: 0.62 × 1.5 = 0.93 < 1,
 * поэтому ответ на ступени k без бонуса всегда дороже ответа на k+1 с
 * максимальным бонусом.
 *
 * Экспертный режим начинается с 0.2 с, а не с 0.1: одна десятая — это меньше,
 * чем длится один слог, узнавать там нечего. И заканчивается на 8 с: если
 * человек не узнал песню за восемь секунд, шестнадцать ему уже не помогут,
 * а раунд затягивается.
 */
export const MODES = {
  normal: {
    id: 'normal',
    stepMs: [2000, 4000, 6000, 10000, 14000, 20000],
    stepPoints: [1800, 1120, 700, 440, 280, 180],
    multiplier: 1.0,
  },
  expert: {
    id: 'expert',
    stepMs: [200, 500, 1000, 2000, 4000, 8000],
    stepPoints: [1500, 950, 600, 380, 240, 150],
    multiplier: 1.8,
  },
};

export const DEFAULT_MODE = 'normal';

export function modeOf(id) {
  return MODES[id] || MODES[DEFAULT_MODE];
}

/* ------------------------------------------------------------------ */
/* Константы формулы                                                   */
/* ------------------------------------------------------------------ */

/**
 * Максимальная доля ступени, которую может добавить скорость.
 *
 * Половина ступени — много, и это намеренно: узнавание с первых нот и есть
 * то, за что в этой игре платят. Верхняя граница задана инвариантом
 * доминирования: при шаге лестницы 0.62 бонус может доходить до 60%,
 * дальше ответ на следующей ступени начал бы обгонять предыдущую.
 */
export const BONUS_FRACTION = 0.5;

/** Пол реакции, секунды: быстрее человек физически не отвечает осмысленно. */
export const REACTION_FLOOR_S = 0.35;

/**
 * Постоянная спада бонуса, секунды. В итерации 2 было 3.5 — бонус обрушивался
 * почти сразу. Шесть секунд дают заметную, но не драматичную разницу:
 * 2 с → 76% бонуса, 6 с → 39%.
 *
 * Время считается не «сколько думал», а «когда узнал»: часы останавливаются в
 * тот момент, когда человек начал набирать ПРАВИЛЬНЫЙ ответ (см. game.js →
 * registerInput). Медленная печать больше не наказывается — наказывается
 * только медленное узнавание.
 */
export const BONUS_TAU_S = 6.0;

/**
 * Жёсткий пол: доля базы ступени, ниже которой верный ответ не оценивается.
 * Угадать за 16 секунд объективно лучше, чем не угадать вовсе, и стоить это
 * обязано больше нуля.
 */
export const FLOOR_FRACTION = 0.10;

/** Раундов в партии — по одному на каждый уровень сложности. */
export const ROUNDS = 5;

/** Теоретический максимум за партию по самому щедрому режиму. */
export const MAX_ROUND_SCORE = Math.max(
  ...Object.values(MODES).map((m) =>
    Math.round(m.stepPoints[0] * (1 + BONUS_FRACTION) * m.multiplier))
);
export const MAX_GAME_SCORE = MAX_ROUND_SCORE * ROUNDS;

/* ------------------------------------------------------------------ */

/** Сколько ступеней в режиме. */
export function stepCount(modeId) {
  return modeOf(modeId).stepMs.length;
}

/** Длительность ступени в миллисекундах. */
export function stepDuration(modeId, stepIndex) {
  const m = modeOf(modeId);
  return m.stepMs[Math.min(stepIndex, m.stepMs.length - 1)];
}

/** Базовые очки за ступень ДО множителя режима. */
export function stepPoints(modeId, stepIndex) {
  const m = modeOf(modeId);
  return m.stepPoints[Math.min(stepIndex, m.stepPoints.length - 1)];
}

/**
 * Бонус за скорость мышления. Всегда ≥ 0 и всегда ≤ BONUS_FRACTION от базы.
 *
 * @param {string} modeId
 * @param {number} stepIndex  ступень, на которой дан верный ответ
 * @param {number|null} timeToFirstInputMs  мс от конца фрагмента до первого ввода,
 *        null — валидного первого ввода не было, бонус просто не начисляется
 * @param {boolean} voided  раунд помечен как «без бонуса» (был неверный ответ)
 */
export function speedBonus(modeId, stepIndex, timeToFirstInputMs, voided = false) {
  if (voided) return 0;
  if (timeToFirstInputMs === null || timeToFirstInputMs === undefined) return 0;
  if (!Number.isFinite(timeToFirstInputMs) || timeToFirstInputMs < 0) return 0;

  const t = timeToFirstInputMs / 1000;
  const over = Math.max(0, t - REACTION_FLOOR_S);
  const decay = Math.exp(-over / BONUS_TAU_S);
  // Math.max(0, …) здесь не для красоты: он делает «бонус не бывает
  // отрицательным» свойством кода, а не следствием того, что exp > 0.
  return Math.max(0, Math.round(stepPoints(modeId, stepIndex) * BONUS_FRACTION * decay));
}

/**
 * Итог раунда.
 * @returns {{base:number, bonus:number, total:number, floored:boolean}}
 *   base и bonus — до множителя режима, total — окончательный.
 */
export function roundScore({ solved, stepIndex, timeToFirstInputMs, bonusVoid, mode }) {
  const m = modeOf(mode);
  if (!solved) return { base: 0, bonus: 0, total: 0, floored: false };

  const base = stepPoints(m.id, stepIndex);
  const bonus = speedBonus(m.id, stepIndex, timeToFirstInputMs, bonusVoid);
  const floor = base * FLOOR_FRACTION;
  const raw = Math.max(base + bonus, floor);

  return {
    base,
    bonus,
    total: Math.round(raw * m.multiplier),
    floored: base + bonus < floor,
  };
}

/**
 * Инвариант «ступень важнее скорости»:
 * ответ на ступени k без бонуса должен побеждать ответ на k+1 с максимальным.
 * Возвращает список нарушений (пустой = всё в порядке).
 */
export function verifyStepDominance() {
  const problems = [];
  for (const m of Object.values(MODES)) {
    for (let k = 0; k < m.stepPoints.length - 1; k++) {
      const bestNext = m.stepPoints[k + 1] * (1 + BONUS_FRACTION);
      if (bestNext >= m.stepPoints[k]) {
        problems.push(
          `[${m.id}] ступень ${k + 1} (${m.stepPoints[k]}) не доминирует над ` +
            `ступенью ${k + 2} с максимальным бонусом (${bestNext.toFixed(1)})`
        );
      }
    }
  }
  return problems;
}

/**
 * Насколько промах близок к правде. Нужно для мягкой обратной связи.
 * @returns {'artist'|'title'|null}
 */
export function nearMissKind(guess, answer) {
  if (!guess || !answer) return null;
  if (foldKey(guess.artist) === foldKey(answer.artist)) return 'artist';
  if (trigramSim(foldKey(guess.title), foldKey(answer.title)) >= 0.55) return 'title';
  return null;
}

/**
 * Индекс вердикта финала 0..4 — только позитивные формулировки.
 * Порог берётся от максимума режима, иначе экспертная партия всегда
 * получала бы верхний вердикт, а обычная — никогда.
 */
export function verdictIndex(total, mode) {
  if (total <= 0) return 0;
  const max = modeOf(mode).stepPoints[0] * (1 + BONUS_FRACTION)
    * modeOf(mode).multiplier * ROUNDS;
  const share = total / max;
  if (share <= 0.2) return 1;
  if (share <= 0.45) return 2;
  if (share <= 0.7) return 3;
  return 4;
}
