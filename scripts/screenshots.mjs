#!/usr/bin/env node
/**
 * Скриншоты для design-review. Гоняет headless Chrome по CDP, проходит партию
 * скриптом и снимает каждый экран.
 *
 * Итерация 2: только десктоп, только тёмная тема — светлой больше нет.
 *
 * Лидерборды по умолчанию выключены (пустой LEADERBOARD_ENDPOINT), поэтому
 * для одного кадра они подменяются заглушкой прямо в странице: иначе правую
 * колонку стартового экрана в ревью было бы не увидеть.
 *
 * Запуск:  npm run screenshots     (dev-сервер должен быть поднят)
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, evaluate, setViewport, sleep, SCRIPTS } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.design', 'tap-anda', 'screenshots');
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const PROFILE = join(ROOT, '.tmp-chrome-shots');

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 720 },
];

const SCENES = [
  { name: 'start', script: null },
  { name: 'round', script: SCRIPTS.toRound },
  { name: 'reveal', script: SCRIPTS.toReveal },
  { name: 'final', script: SCRIPTS.toFinal },
];

/**
 * Заглушка лидербордов — только для скриншота, в продакшене её нет.
 * Подменяет ответ сети; сам эндпоинт временно прописывается в config.js
 * (файл восстанавливается в finally).
 */
const MOCK_LB = `
  window.__MOCK_LB__ = true;
  const rows = (n, seed) => Array.from({ length: n }, (_, i) => ({
    nick: ['Nurali','Айгүл','Ерлан','Dana','Мадина','Aibek','Жанна'][(i + seed) % 7],
    score: 6100 - i * 420 - seed * 30,
    date: new Date().toISOString(),
  }));
  const realFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (String(url).includes('MOCK_ENDPOINT')) {
      return Promise.resolve(new Response(JSON.stringify({
        ok: true, allTime: rows(7, 0), today: rows(5, 3),
      }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
`;

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('  →', `${name}.png`);
}

const CONFIG_PATH = join(ROOT, 'src', 'config.js');

async function main() {
  await mkdir(OUT, { recursive: true });
  const cdp = await launch({ port: 9335, profile: PROFILE });
  let configBackup = null;

  try {
    for (const vp of VIEWPORTS) {
      await setViewport(cdp, vp.width, vp.height);
      for (const scene of SCENES) {
        await cdp.send('Page.navigate', { url: `${BASE}/` });
        await sleep(300);
        // Язык и кэш офсетов не должны протекать между кадрами.
        await evaluate(cdp, `localStorage.clear(); return 1;`);
        await cdp.send('Page.reload');
        await sleep(900);
        await evaluate(cdp, SCRIPTS.ready);
        if (scene.script) await evaluate(cdp, scene.script);
        await sleep(600);
        await shot(cdp, `review-${scene.name}-${vp.name}`);
      }
    }

    // Оверлей правил
    await setViewport(cdp, 1440, 900);
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(900);
    await evaluate(cdp, SCRIPTS.ready);
    await evaluate(cdp, SCRIPTS.rules);
    await shot(cdp, 'review-rules-1440');

    // Русский интерфейс
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(900);
    await evaluate(cdp, SCRIPTS.ready);
    await evaluate(cdp, `document.querySelector('[data-locale="ru"]').click();
                         await new Promise(r => setTimeout(r, 600)); return 'ru';`);
    await shot(cdp, 'review-start-ru-1440');

    // Стартовый экран с включёнными лидербордами.
    // CONFIG читается модулем при импорте, поэтому правка объекта в рантайме
    // ничего не даёт — временно подменяем сам файл и возвращаем его обратно.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_LB });
    configBackup = await readFile(CONFIG_PATH, 'utf8');
    await writeFile(
      CONFIG_PATH,
      configBackup.replace("LEADERBOARD_ENDPOINT: ''", "LEADERBOARD_ENDPOINT: 'https://MOCK_ENDPOINT/exec'"),
      'utf8'
    );
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(300);
    await evaluate(cdp, `localStorage.clear(); return 1;`);
    await cdp.send('Page.reload');
    await sleep(1800);
    await evaluate(cdp, SCRIPTS.ready);
    await sleep(700);
    await shot(cdp, 'review-start-leaderboards-1440');
  } finally {
    if (configBackup !== null) await writeFile(CONFIG_PATH, configBackup, 'utf8');
    await cdp.close();
  }

  console.log(`\nГотово: ${OUT}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
