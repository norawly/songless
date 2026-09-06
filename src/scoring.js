/**
 * Система очков. Все константы — здесь и только здесь.
 * Полный ресёрч и вывод формулы: SCORING.md
 *
 *   round = S_k + S_k · β · exp( −max(0, t − t₀) / τ )
 *
 * S_k — базовая цена ступени, t — время до ПЕРВОГО ввода после окончания
 * фрагмента, t₀ — физиологический пол реакции, τ — постоянная спада,
 * β — доля ступени, которую максимум может дать скорость.
 */

import { foldKey, trigramSim } from './normalize.js';

/** Длительности ступеней в миллисекундах. Первая — одна десятая секунды. */
export const STEP_MS = [100, 500, 1000, 2000, 4000, 8000, 16000];

/** Цена ступени. Геометрическая прогрессия r≈0.70, см. SCORING.md §3.1. */
export const STEP_POINTS = [1000, 700, 500, 350, 250, 175, 120];

export const STEPS = STEP_MS.length; // 7

/** Доля ступени, которую максимум может дать бонус за скорость. β < 0.400. */
export const BONUS_FRACTION = 1 / 3;

/** Пол реакции, секунды. Быстрее — полный бонус (SCORING.md §3.2). */
export const REACTION_FLOOR_S = 0.35;

/** Постоянная экспоненциального спада бонуса, секунды (SCORING.md §3.3). */
export const BONUS_TAU_S = 3.5;

/** Раундов в партии — по одному на каждый уровень сложности. */
export const ROUNDS = 5;

/** Теоретический максимум за партию. Используется и в Apps Script. */
export const MAX_ROUND_SCORE = Math.round(STEP_POINTS[0] * (1 + BONUS_FRACTION));
export const MAX_GAME_SCORE = MAX_ROUND_SCORE * ROUNDS;

/** Базовые очки за ступень (индекс 0..6). */
export function stepPoints(stepIndex) {
  return STEP_POINTS[Math.min(stepIndex, STEPS - 1)];
}

/**
 * Бонус за скорость мышления.
 * @param {number} stepIndex  ступень, на которой дан верный ответ
 * @param {number|null} timeToFirstInputMs  мс от конца фрагмента до первого ввода,
 *        null — если валидного первого ввода не было (бонус просто не начисляется)
 * @param {boolean} voided  раунд помечен как «без бонуса» (был неверный ответ)
 */
export function speedBonus(stepIndex, timeToFirstInputMs, voided = false) {
  if (voided) return 0;
  if (timeToFirstInputMs === null || timeToFirstInputMs === undefined) return 0;
  if (!Number.isFinite(timeToFirstInputMs) || timeToFirstInputMs < 0) return 0;

  const t = timeToFirstInputMs / 1000;
  const over = Math.max(0, t - REACTION_FLOOR_S);
  const decay = Math.exp(-over / BONUS_TAU_S);
  return Math.round(stepPoints(stepIndex) * BONUS_FRACTION * decay);
}

/** Итог раунда. Неверно/пропущено = ровно 0, отрицательных значений не бывает. */
export function roundScore({ solved, stepIndex, timeToFirstInputMs, bonusVoid }) {
  if (!solved) return { base: 0, bonus: 0, total: 0 };
  const base = stepPoints(stepIndex);
  const bonus = speedBonus(stepIndex, timeToFirstInputMs, bonusVoid);
  return { base, bonus, total: base + bonus };
}

/**
 * Инвариант «ступень важнее скорости»:
 * ответ на ступени k без бонуса должен побеждать ответ на k+1 с максимальным.
 * Возвращает список нарушений (пустой = всё в порядке).
 */
export function verifyStepDominance() {
  const problems = [];
  for (let k = 0; k < STEPS - 1; k++) {
    const bestNext = STEP_POINTS[k + 1] * (1 + BONUS_FRACTION);
    if (bestNext >= STEP_POINTS[k]) {
      problems.push(
        `ступень ${k + 1} (${STEP_POINTS[k]}) не доминирует над ступенью ${k + 2} ` +
          `с максимальным бонусом (${bestNext.toFixed(1)})`
      );
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

/** Индекс вердикта финала 0..4 — только позитивные формулировки. */
export function verdictIndex(total) {
  if (total <= 0) return 0;
  if (total <= 1500) return 1;
  if (total <= 3500) return 2;
  if (total <= 5000) return 3;
  return 4;
}
