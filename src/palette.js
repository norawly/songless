/**
 * Извлечение доминирующих цветов из обложки альбома.
 *
 * Без внешних библиотек: обложка рисуется в canvas 48×48, пиксели
 * квантуются по 4 бита на канал (4096 корзин), берутся самые населённые
 * корзины, достаточно далёкие друг от друга.
 *
 * CDN обложек Apple (is1-ssl.mzstatic.com) отдаёт `access-control-allow-origin: *`
 * — проверено, — поэтому canvas не «портится» и getImageData работает.
 * Если по какой-то причине картинка не загрузится или canvas окажется
 * tainted, возвращаем null: фон просто останется нейтральным, игра не падает.
 */

/** Размер, до которого ужимаем обложку. 48×48 = 2304 пикселя — этого хватает. */
const SAMPLE = 48;

/** Сколько цветов возвращаем. */
const COUNT = 3;

/** Минимальное расстояние между выбранными цветами (в RGB), чтобы не брать оттенки одного. */
const MIN_DISTANCE = 60;

const cache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (tt) => {
    let t = tt;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

/**
 * Подгоняет цвет под тёмный фон: поднимает насыщенность и приводит светлоту
 * в диапазон, где цвет виден, но не слепит.
 */
function fitForDarkBg([r, g, b]) {
  let [h, s, l] = rgbToHsl(r, g, b);
  s = Math.min(1, Math.max(s, 0.45));
  l = Math.min(0.62, Math.max(0.34, l));
  return hslToRgb(h, s, l);
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * @param {Uint8ClampedArray} data
 * @param {{minS:number, minL:number, maxL:number}} th пороги отсева
 */
function quantize(data, th) {
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 200) continue;

    const [, s, l] = rgbToHsl(r, g, b);
    // Почти чёрные, почти белые и полностью серые пиксели дают ложное
    // «доминирование»: у половины обложек фон чёрный.
    if (l < th.minL || l > th.maxL) continue;
    if (s < th.minS) continue;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  }

  return [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .map((x) => [
      Math.round(x.r / x.n),
      Math.round(x.g / x.n),
      Math.round(x.b / x.n),
    ]);
}

/**
 * Три прохода со всё более мягкими порогами.
 *
 * Строгий фильтр отсекает серое и почти чёрное — на цветной обложке это
 * правильно, но чёрно-белых и приглушённых обложек много, и на них строгий
 * проход не оставлял НИ ОДНОГО пикселя: фон тогда просто не включался.
 * Поэтому если строгий проход пуст, требования к насыщенности ослабляются,
 * а на последнем проходе берётся что угодно видимое — цвет всё равно будет
 * поднят под тёмный фон в fitForDarkBg.
 */
function quantizeAdaptive(data) {
  const passes = [
    { minS: 0.12, minL: 0.12, maxL: 0.93 },
    { minS: 0.05, minL: 0.08, maxL: 0.96 },
    { minS: 0.00, minL: 0.03, maxL: 0.99 },
  ];
  for (const th of passes) {
    const out = quantize(data, th);
    if (out.length) return out;
  }
  return [];
}

/**
 * @param {string} url обложка
 * @param {string} [cacheKey] обычно id трека
 * @returns {Promise<string[]|null>} массив CSS-цветов вида 'rgb(r g b)'
 */
export function extractPalette(url, cacheKey = url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    const fail = () => {
      cache.set(cacheKey, null);
      resolve(null);
    };

    img.onerror = fail;
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

        const ranked = quantizeAdaptive(data);
        if (ranked.length === 0) return fail();

        const chosen = [];
        for (const c of ranked) {
          if (chosen.length >= COUNT) break;
          if (chosen.every((p) => distance(p, c) >= MIN_DISTANCE)) chosen.push(c);
        }
        // Если обложка почти монохромная — добираем ближайшими, лишь бы
        // получить три точки для градиента.
        while (chosen.length < COUNT && ranked.length) {
          chosen.push(ranked[chosen.length % ranked.length]);
        }

        const css = chosen
          .map(fitForDarkBg)
          .map(([r, g, b]) => `rgb(${r} ${g} ${b})`);
        cache.set(cacheKey, css);
        resolve(css);
      } catch {
        // canvas tainted или getImageData запрещён — фон останется нейтральным
        fail();
      }
    };

    img.src = url;
  });
}
