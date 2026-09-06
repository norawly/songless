#!/usr/bin/env node
/**
 * Генерирует og-image.png 1200×630 — превью для соцсетей и первый кадр,
 * который человек видит по ссылке.
 *
 * Композиция: сетка реальных обложек из каталога как фон, поверх — тёмная
 * вуаль, крупная типографика, один акцент и одна кнопка действия.
 * Рисуется в headless Chrome по той же вёрстке и тем же токенам, что и игра,
 * поэтому картинка не расходится с сайтом.
 *
 * Запуск: npm run og   (dev-сервер должен быть поднят)
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch, evaluate, setViewport, sleep } from './lib/cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'og-image.png');
const PROFILE = join(ROOT, '.tmp-chrome-og');
const BASE = process.env.BASE_URL || 'http://localhost:5173';

const catalog = JSON.parse(await readFile(join(ROOT, 'data', 'tracks.json'), 'utf8'));

/* Токены встраиваем текстом, а не ссылкой: страница открывается как data: URL,
   у которого непрозрачный origin, и внешний CSS оттуда не загружается —
   картинка получалась белой, с serif-шрифтом и без акцента.
   Файл всё равно читается с диска, так что источник значений один. */
const tokensCss = await readFile(join(ROOT, 'styles', 'tokens.css'), 'utf8');

/** Берём обложки вразброс по каталогу — так сетка получается разноцветной. */
const arts = [];
const step = Math.max(1, Math.floor(catalog.tracks.length / 60));
for (let i = 0; i < catalog.tracks.length && arts.length < 60; i += step) {
  const a = catalog.tracks[i].art;
  if (a) arts.push(a.replace('/600x600bb.', '/200x200bb.'));
}

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${tokensCss}</style>
<style>
  html, body { margin:0; width:1200px; height:630px; overflow:hidden;
               background: var(--color-bg-primary); }
  .wrap { position:relative; width:1200px; height:630px;
          font-family: var(--font-family-display); color: var(--color-text-primary); }

  /* Фон — сетка обложек каталога. Слегка притушена и уведена вбок,
     чтобы не спорить с типографикой. */
  .tiles { position:absolute; inset:-40px -40px -40px 46%;
           display:grid; grid-template-columns:repeat(6,1fr); gap:6px;
           transform: rotate(-8deg) scale(1.18); opacity:.85; }
  .tiles img { width:100%; aspect-ratio:1; object-fit:cover; display:block; }
  .veil { position:absolute; inset:0;
          background: linear-gradient(90deg,
            var(--color-bg-primary) 0%,
            var(--color-bg-primary) 42%,
            rgba(8,9,10,.86) 56%,
            rgba(8,9,10,.62) 100%); }

  .content { position:absolute; inset:0; padding:64px 72px;
             display:grid; align-content:center; gap:22px; width:640px; }
  .eyebrow { font-size:15px; font-weight:700; letter-spacing:.18em;
             text-transform:uppercase; color: var(--color-text-secondary); }
  .title { font-size:118px; line-height:.92; letter-spacing:-.045em; font-weight:700; }
  .tag { font-size:26px; color: var(--color-text-secondary); max-width:16ch; line-height:1.25; }
  .row { display:flex; align-items:center; gap:18px; margin-top:6px; }
  .cta { display:inline-flex; align-items:center; padding:15px 34px;
         background: var(--color-accent-primary); color: var(--color-accent-on);
         font-size:22px; font-weight:700; border-radius:2px; }
  .meta { font-size:17px; color: var(--color-text-tertiary); font-variant-numeric:tabular-nums; }
  .mark { position:absolute; left:72px; top:52px;
          display:flex; align-items:center; gap:11px; }
  .mark i { width:15px; height:15px; background: var(--color-accent-primary); display:block; }
  .mark span { font-size:15px; font-weight:700; letter-spacing:.2em; }
</style></head>
<body><div class="wrap">
  <div class="tiles">${arts.map((a) => `<img src="${a}" crossorigin="anonymous">`).join('')}</div>
  <div class="veil"></div>
  <div class="mark"><i></i><span>ТАП ӘНДІ</span></div>
  <div class="content">
    <div class="eyebrow">Қазақ әндерін таны</div>
    <div class="title">ТАП<br>ӘНДІ</div>
    <div class="tag">Әнді 0,1 секундтан танисың ба?</div>
    <div class="row">
      <span class="cta">Бастау</span>
      <span class="meta">${catalog.count} ән · 5 раунд · 7 талпыныс</span>
    </div>
  </div>
</div></body></html>`;

const cdp = await launch({ port: 9336, profile: PROFILE });
try {
  await setViewport(cdp, 1200, 630);
  await cdp.send('Page.navigate', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html),
  });
  await sleep(1200);
  // Дожидаемся реальной загрузки всех обложек, иначе в кадр попадут дыры.
  const loaded = await evaluate(cdp, `
    const imgs = [...document.images];
    await Promise.all(imgs.map(i => i.complete ? 1 : new Promise(r => {
      i.onload = r; i.onerror = r;
    })));
    return imgs.filter(i => i.naturalWidth > 0).length + '/' + imgs.length;
  `);
  await sleep(400);

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
  });
  await writeFile(OUT, Buffer.from(data, 'base64'));
  console.log(`og-image.png 1200×630 готов (обложек загружено ${loaded})`);
} finally {
  await cdp.close();
}
