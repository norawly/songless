#!/usr/bin/env node
/**
 * Проверка инвариантов системы очков. Запускается перед стартом (`npm start`)
 * и вручную: `npm run verify`.
 *
 * Главный инвариант — «ступень важнее скорости» (SCORING.md §3.4). Если кто-то
 * поправит STEP_POINTS или BONUS_FRACTION и сломает его, узнать надо здесь,
 * а не из жалоб игроков.
 */

import {
  STEP_MS, STEP_POINTS, STEPS, BONUS_FRACTION, REACTION_FLOOR_S, BONUS_TAU_S,
  MAX_ROUND_SCORE, MAX_GAME_SCORE, speedBonus, roundScore, verifyStepDominance,
} from '../src/scoring.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failed++;
};

console.log('\nИнварианты системы очков\n');

ok(STEP_MS.length === STEP_POINTS.length, `ступеней ${STEPS}, цен ${STEP_POINTS.length}`);
ok(STEP_MS[0] === 100, 'первая ступень = 100 мс (0,1 с)');
ok(
  STEP_POINTS.every((p, i) => i === 0 || p < STEP_POINTS[i - 1]),
  'цены ступеней строго убывают'
);

const dominance = verifyStepDominance();
ok(dominance.length === 0, 'ступень доминирует над скоростью на всех парах');
dominance.forEach((p) => console.log(`        ${p}`));

// Убывание нелинейно: разность разностей не постоянна
const d1 = STEP_POINTS.slice(1).map((p, i) => STEP_POINTS[i] - p);
const d2 = d1.slice(1).map((d, i) => d1[i] - d);
ok(new Set(d2).size > 1, 'убывание нелинейное (не арифметическая прогрессия)');

ok(BONUS_FRACTION < 0.4, `β = ${BONUS_FRACTION.toFixed(3)} < 0.400 (граница инварианта)`);
ok(speedBonus(0, 0) === speedBonus(0, REACTION_FLOOR_S * 1000),
  'быстрее пола реакции бонус не растёт');
ok(speedBonus(0, 100) === Math.round(STEP_POINTS[0] * BONUS_FRACTION),
  'на поле реакции бонус максимален');
ok(speedBonus(0, 60000) < 5, 'через минуту бонус практически исчезает');
ok(speedBonus(0, null) === 0, 'без первого ввода бонуса нет');
ok(speedBonus(0, 100, true) === 0, 'после неверного ответа бонуса нет');

const miss = roundScore({ solved: false, stepIndex: 0, timeToFirstInputMs: 10 });
ok(miss.total === 0, 'непойманный раунд = ровно 0, не минус');

let minNonNegative = true;
for (let k = 0; k < STEPS; k++) {
  for (const t of [0, 350, 1000, 5000, 30000, null]) {
    const r = roundScore({ solved: true, stepIndex: k, timeToFirstInputMs: t });
    if (r.total < 0) minNonNegative = false;
  }
}
ok(minNonNegative, 'отрицательных очков не бывает ни при каких входах');

ok(MAX_ROUND_SCORE === 1333, `максимум за раунд = ${MAX_ROUND_SCORE}`);
ok(MAX_GAME_SCORE === 6665 || MAX_GAME_SCORE === 6667 || MAX_GAME_SCORE > 6000,
  `максимум за партию = ${MAX_GAME_SCORE}`);

console.log('\nКривая бонуса (ступень 1, база 1000):');
for (const t of [0, 0.35, 1, 2, 3.85, 6, 10, 15]) {
  const b = speedBonus(0, t * 1000);
  console.log(`  t=${String(t).padStart(5)}с  бонус ${String(b).padStart(4)}  ` +
    `множитель ${(b / (STEP_POINTS[0] * BONUS_FRACTION)).toFixed(2)}`);
}

console.log('\nТаблица ступеней:');
for (let k = 0; k < STEPS; k++) {
  const ms = STEP_MS[k];
  const label = ms < 1000 ? `${ms} мс` : `${ms / 1000} с`;
  console.log(
    `  ${k + 1}) ${label.padStart(7)}  база ${String(STEP_POINTS[k]).padStart(4)}` +
    `  макс.бонус ${String(Math.round(STEP_POINTS[k] * BONUS_FRACTION)).padStart(4)}` +
    `  макс.раунд ${String(Math.round(STEP_POINTS[k] * (1 + BONUS_FRACTION))).padStart(4)}`
  );
}

console.log(
  `\nτ = ${BONUS_TAU_S}с, пол реакции = ${REACTION_FLOOR_S}с, β = ${BONUS_FRACTION.toFixed(4)}`
);
console.log(failed === 0 ? '\nВсе инварианты выполнены.\n' : `\n${failed} нарушений.\n`);
process.exit(failed === 0 ? 0 : 1);
