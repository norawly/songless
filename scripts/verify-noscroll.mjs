#!/usr/bin/env node
/**
 * Проверка жёсткого требования: НИ ОДИН экран не скроллится.
 *
 * Гоняет headless Chrome по всем экранам на нескольких высотах вьюпорта и
 * проверяет два условия:
 *   1. документ не выше вьюпорта (нет вертикальной прокрутки);
 *   2. элементы, которые прятать нельзя ни при какой плотности, видимы:
 *      кнопка воспроизведения, поле поиска, кнопка пропуска, текущий счёт,
 *      индикатор ступени.
 *
 * Аварийный сценарий (высота < 480px) из проверки исключён: там прокрутка
 * разрешена сознательно, когда деградация уже исчерпана.
 *
 * Запуск: npm run verify:noscroll   (dev-сервер должен быть поднят)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, evaluate, setViewport, sleep, SCRIPTS } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const PROFILE = join(ROOT, '.tmp-chrome-noscroll');

/** Высоты, на которых должно помещаться без прокрутки. */
const VIEWPORTS = [
  { w: 1920, h: 1080, note: 'большой десктоп' },
  { w: 1440, h: 900, note: 'база' },
  { w: 1366, h: 768, note: 'массовый ноутбук' },
  { w: 1280, h: 720, note: 'низкий ноутбук' },
  { w: 1280, h: 620, note: 'зум 125%' },
  { w: 1280, h: 520, note: 'зум 175%, деградация на пределе' },
];

const SCENES = [
  { name: 'старт', script: null, must: ['[data-start]'] },
  {
    name: 'раунд',
    script: SCRIPTS.toRound,
    // Эти пять элементов не прячутся ни при какой плотности.
    must: ['[data-play]', '#answer-input', '[data-act]', '[data-total-score]', '.steps'],
  },
  { name: 'карточка', script: SCRIPTS.toReveal, must: ['[data-next]', '.card__artist'] },
  {
    name: 'финал',
    script: SCRIPTS.toFinal,
    must: ['#final-grid', '[data-share]', '[data-again]', '[data-total]'],
  },
];

const CHECK = `
  const notScrolled = document.documentElement.scrollHeight <= window.innerHeight + 1;
  const main = document.getElementById('screen');
  const mainOk = main.scrollHeight <= main.clientHeight + 1;
  return {
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
    notScrolled,
    mainOk,
    dense: document.documentElement.dataset.dense,
  };
`;

const visible = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'MISSING';
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return 'HIDDEN';
  if (r.width < 1 || r.height < 1) return 'ZERO';
  if (r.bottom > window.innerHeight + 1 || r.top < -1) return 'OFFSCREEN';
  return 'OK';
`;

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failed++;
};

const cdp = await launch({ port: 9334, profile: PROFILE });

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.w}×${vp.h} — ${vp.note} ===`);
    await setViewport(cdp, vp.w, vp.h);

    for (const scene of SCENES) {
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await sleep(900);
      await evaluate(cdp, SCRIPTS.ready);
      if (scene.script) await evaluate(cdp, scene.script);
      await sleep(400);

      const res = await evaluate(cdp, CHECK);
      ok(
        res.notScrolled,
        `${scene.name.padEnd(9)} без прокрутки (документ ${res.scrollH} ≤ ${res.innerH}, плотность ${res.dense})`
      );

      for (const sel of scene.must) {
        const state = await evaluate(cdp, visible(sel));
        ok(state === 'OK', `${scene.name.padEnd(9)} виден ${sel} → ${state}`);
      }
    }
  }
} finally {
  await cdp.close();
}

console.log(failed === 0
  ? '\nВсе экраны помещаются в вьюпорт, обязательные элементы на месте.\n'
  : `\n${failed} нарушений.\n`);
process.exit(failed === 0 ? 0 : 1);
