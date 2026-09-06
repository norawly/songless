#!/usr/bin/env node
/**
 * Исполняемая проверка системы очков. Гоняется перед каждым релизом:
 * `npm run verify`.
 *
 * Проверяются ровно те свойства, которые обещаны в SCORING.md, — в первую
 * очередь три правила итерации 3: бонус только добавляет, верный ответ никогда
 * не стоит нуля, ступень всегда важнее скорости.
 */

import {
  MODES, ROUNDS, BONUS_FRACTION, REACTION_FLOOR_S, BONUS_TAU_S, FLOOR_FRACTION,
  MAX_ROUND_SCORE, MAX_GAME_SCORE,
  roundScore, speedBonus, stepPoints, stepCount, verifyStepDominance, verdictIndex,
} from '../src/scoring.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

const MODE_IDS = Object.keys(MODES);

console.log('\n— Ступень важнее скорости —');
{
  const problems = verifyStepDominance();
  ok(problems.length === 0, 'ответ на ступени k без бонуса дороже ответа на k+1 с максимальным');
  problems.forEach((p) => console.log('        ', p));

  for (const id of MODE_IDS) {
    const n = stepCount(id);
    let bad = 0;
    for (let k = 0; k < n - 1; k++) {
      const slowHere = roundScore({ solved: true, stepIndex: k, timeToFirstInputMs: 60000, mode: id });
      const fastNext = roundScore({ solved: true, stepIndex: k + 1, timeToFirstInputMs: 0, mode: id });
      if (fastNext.total >= slowHere.total) bad++;
    }
    ok(bad === 0, `[${id}] то же самое на реальных числах, все ступени`);
  }
}

console.log('\n— Бонус только добавляет (блок E2) —');
{
  for (const id of MODE_IDS) {
    const n = stepCount(id);
    let negative = 0;
    let overCap = 0;
    let reducesBase = 0;
    for (let k = 0; k < n; k++) {
      const base = stepPoints(id, k);
      for (const ms of [0, 100, 350, 1000, 2000, 6000, 20000, 120000, null]) {
        const b = speedBonus(id, k, ms);
        if (b < 0) negative++;
        if (b > base * BONUS_FRACTION + 1) overCap++;
        const r = roundScore({ solved: true, stepIndex: k, timeToFirstInputMs: ms, mode: id });
        if (r.total < Math.round(base * MODES[id].multiplier)) reducesBase++;
      }
    }
    ok(negative === 0, `[${id}] бонус никогда не отрицательный`);
    ok(overCap === 0, `[${id}] бонус не выше ${Math.round(BONUS_FRACTION * 100)}% базы`);
    ok(reducesBase === 0, `[${id}] бонус никогда не уменьшает базу ступени`);
  }
}

console.log('\n— Жёсткий пол: верный ответ ≠ 0 (блок E1) —');
{
  for (const id of MODE_IDS) {
    const n = stepCount(id);
    let zeros = 0;
    for (let k = 0; k < n; k++) {
      // Самый плохой возможный случай: последняя ступень, был неверный ответ
      // (бонус аннулирован), отвечал долго.
      const r = roundScore({
        solved: true, stepIndex: k, timeToFirstInputMs: null, bonusVoid: true, mode: id,
      });
      if (r.total <= 0) zeros++;
      const floor = stepPoints(id, k) * FLOOR_FRACTION * MODES[id].multiplier;
      if (r.total < Math.floor(floor)) zeros++;
    }
    ok(zeros === 0, `[${id}] на любой ступени верный ответ стоит больше нуля и не ниже пола`);

    const last = stepCount(id) - 1;
    const worst = roundScore({
      solved: true, stepIndex: last, timeToFirstInputMs: null, bonusVoid: true, mode: id,
    });
    ok(worst.total > 0, `[${id}] последняя ступень: угадал за ${MODES[id].stepMs[last] / 1000} с`,
      `${worst.total} очков`);
  }

  const missed = roundScore({ solved: false, stepIndex: 0, timeToFirstInputMs: 0, mode: 'expert' });
  ok(missed.total === 0, 'ноль возможен только у неугаданного трека');
}

console.log('\n— Спад бонуса пологий (блок E2) —');
{
  for (const id of MODE_IDS) {
    const b2 = speedBonus(id, 0, 2000);
    const b6 = speedBonus(id, 0, 6000);
    const ratio = b2 / b6;
    // «Заметно, но не драматично»: быстрый ответ лучше в 1,5–2,5 раза.
    ok(ratio > 1.4 && ratio < 2.6, `[${id}] 2 с против 6 с различимы, но не драматично`,
      `${b2} против ${b6}, в ${ratio.toFixed(2)} раза`);
  }
  ok(BONUS_TAU_S >= 5, 'постоянная времени увеличена относительно итерации 2 (3,5 с)',
    `τ = ${BONUS_TAU_S} с`);

  const instant = speedBonus('expert', 0, 0);
  const atFloor = speedBonus('expert', 0, REACTION_FLOOR_S * 1000);
  ok(instant === atFloor, 'быстрее физиологического пола бонус не растёт',
    `${REACTION_FLOOR_S} с`);
}

console.log('\n— Множитель режима (блок B1) —');
{
  const n = roundScore({ solved: true, stepIndex: 0, timeToFirstInputMs: 1000, mode: 'normal' });
  const e = roundScore({ solved: true, stepIndex: 0, timeToFirstInputMs: 1000, mode: 'expert' });
  ok(MODES.expert.multiplier === 1.8 && MODES.normal.multiplier === 1.0,
    'коэффициенты: обычный ×1,0, экспертный ×1,8');
  ok(e.total > n.total, 'та же ступень в экспертном режиме дороже',
    `${n.total} против ${e.total}`);
  ok(MODES.normal.stepMs.join(',') === '2000,4000,6000,10000,14000,20000',
    'обычный режим: 2 → 4 → 6 → 10 → 14 → 20 с');
  ok(MODES.expert.stepMs.join(',') === '100,500,1000,2000,4000,8000,16000',
    'экспертный режим: 0,1 → 0,5 → 1 → 2 → 4 → 8 → 16 с');
}

console.log('\n— Границы партии —');
{
  const best = roundScore({ solved: true, stepIndex: 0, timeToFirstInputMs: 0, mode: 'expert' });
  ok(best.total <= MAX_ROUND_SCORE, 'лучший возможный раунд не превышает MAX_ROUND_SCORE',
    `${best.total} ≤ ${MAX_ROUND_SCORE}`);
  ok(MAX_GAME_SCORE === MAX_ROUND_SCORE * ROUNDS, 'максимум партии = максимум раунда × 5',
    `${MAX_GAME_SCORE}`);

  const verdicts = [0, 500, 3000, 6000, 11250].map((v) => verdictIndex(v, 'expert'));
  ok(verdicts.every((v, i) => i === 0 || v >= verdicts[i - 1]), 'вердикт не падает с ростом счёта',
    verdicts.join(' → '));
  ok(verdictIndex(0, 'normal') === 0, 'ноль очков — отдельный, но не обидный вердикт');
}

console.log('\n— Примеры расчёта (те же, что в SCORING.md) —');
{
  const rows = [
    ['expert', 0, 500, false, 'мгновенно на первой ступени'],
    ['expert', 6, 8000, true, 'медленно на последней, после промаха'],
    ['normal', 0, 800, false, 'обычный режим, первая ступень'],
    ['normal', 5, 12000, true, 'обычный режим, последняя ступень'],
  ];
  for (const [mode, step, ms, voided, label] of rows) {
    const r = roundScore({
      solved: true, stepIndex: step, timeToFirstInputMs: ms, bonusVoid: voided, mode,
    });
    console.log(`         ${label.padEnd(42)} база ${String(r.base).padStart(4)} + бонус ${String(r.bonus).padStart(3)} → ${r.total}`);
  }
}

console.log(failed === 0 ? '\nСистема очков в порядке.\n' : `\n${failed} провалов.\n`);
process.exit(failed === 0 ? 0 : 1);
