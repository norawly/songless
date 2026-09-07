#!/usr/bin/env node
/**
 * Иконки приложения для установки на домашний экран.
 *
 * Рисуются тем же знаком, что и фавиконка: три полосы эквалайзера на лаймовом
 * поле. Один источник — разметка ниже, поэтому иконка на телефоне и вкладка в
 * браузере не разъезжаются.
 *
 * Форматов два, и это важно:
 *   any      — знак во всё поле, для Android-лаунчеров и вкладок;
 *   maskable — тот же знак с запасом по краям (safe zone 40%): Android режет
 *              иконку под форму темы, и без запаса он отрежет полосы.
 * Отдельно 180×180 для apple-touch-icon: iOS кладёт на домашний экран именно
 * его и сам скругляет углы, поэтому фон обязан быть непрозрачным.
 *
 * Запуск: npm run icons
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, evaluate, sleep } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
const PROFILE = join(ROOT, '.tmp-chrome-icons');

/** @param {number} pad доля поля, оставленная пустой по краям */
const page = (pad) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: 512px; height: 512px; background: #ccff00; }
  svg { display: block; width: 512px; height: 512px; }
</style>
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" fill="#ccff00"/>
  <g transform="translate(16 16) scale(${1 - pad * 2}) translate(-16 -16)">
    <rect x="6"  y="9"  width="4" height="14" fill="#000"/>
    <rect x="14" y="5"  width="4" height="22" fill="#000"/>
    <rect x="22" y="13" width="4" height="6"  fill="#000"/>
  </g>
</svg>`;

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.2 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.06 },
];

await mkdir(OUT, { recursive: true });

const cdp = await launch({ port: 9337, profile: PROFILE });
try {
  for (const { file, size, pad } of TARGETS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      // deviceScaleFactor: 1 намеренно. Масштаб задаётся один раз, в clip:
      // если множить его ещё и здесь, 192 превращается в 72.
      width: 512, height: 512, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', {
      url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(pad)),
    });
    await sleep(250);
    await evaluate(cdp, 'return 1');
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 512, height: 512, scale: size / 512 },
    });
    await writeFile(join(OUT, file), Buffer.from(data, 'base64'));
    console.log(`icons/${file} ${size}×${size}`);
  }
} finally {
  await cdp.close();
}
