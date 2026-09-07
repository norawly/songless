/**
 * Извлечение доминирующих цветов из обложки альбома.
 *
 * Без внешних библиотек: обложка рисуется в canvas 64×64, пиксели квантуются
 * по 4 бита на канал (4096 корзин), корзины ранжируются по РЕАЛЬНОЙ ДОЛЕ
 * пикселей.
 *
 * Итерация 3.1 — главное изменение: раньше белые, чёрные и серые пиксели
 * выбрасывались как «ложное доминирование». На практике это врало: у обложки,
 * где 70% белого и 3% розового, доминирующим объявлялся розовый, и фон
 * становился розовым. Теперь считается ровно то, чего на картинке больше,
 * а белое и чёрное — полноценные цвета. Вместе с цветом возвращается его доля,
 * и фон рисует пятна тем крупнее, чем больше доля.
 *
 * CDN обложек Apple (is1-ssl.mzstatic.com) отдаёт `access-control-allow-origin: *`
 * — проверено, — поэтому canvas не «портится» и getImageData работает.
 * Если по какой-то причине картинка не загрузится или canvas окажется
 * tainted, возвращаем null: фон просто останется нейтральным, игра не падает.
 */

/** Размер, до которого ужимаем обложку. 64×64 = 4096 пикселей. */
const SAMPLE = 64;

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
 * Подгонка под фон: цвет обязан быть виден.
 *
 * Насыщенность не выдумывается там, где её нет (иначе серо-белая обложка
 * превращалась бы в кислотное пятно), но у явно цветного пикселя она
 * подтягивается: приглушённая обложка иначе давала тусклый, почти
 * неразличимый фон. Светлота поднимается к рабочему диапазону — чёрное
 * становится тёмно-цветным, а не исчезает. Белое остаётся белым.
 */
function fitForBg([r, g, b]) {
  const [h, s0, l0] = rgbToHsl(r, g, b);
  // Цветной — подтягиваем насыщенность; серый оставляем серым.
  const s = s0 > 0.08 ? Math.min(0.95, Math.max(s0, 0.42)) : s0;
  // Нижняя граница выше прежней: слишком тёмный цвет на фоне не читается.
  const l = Math.min(0.88, Math.max(0.34, l0));
  return hslToRgb(h, s, l);
}

/**
 * Насколько цвет заметен на фоне. Нужен, чтобы огромная чёрная плашка не
 * занимала все три места: у обложки, где 80% чёрного и 5% фиолетового,
 * фиолетовый обязан попасть в палитру.
 */
function vividness([r, g, b]) {
  const [, s, l] = rgbToHsl(r, g, b);
  const light = 1 - Math.abs(l - 0.55) / 0.55;      // ближе к середине — заметнее
  return 0.25 + 0.45 * s + 0.30 * Math.max(0, light);
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Считает корзины по всем видимым пикселям и ранжирует их по доле.
 * Ничего не отсеивается: белое и чёрное — такие же цвета, как остальные.
 *
 * @param {Uint8ClampedArray} data
 * @returns {Array<{rgb:number[], share:number}>}
 */
function quantize(data) {
  const buckets = new Map();
  let total = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    total++;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  }
  if (!total) return [];

  return [...buckets.values()]
    .map((x) => {
      const rgb = [Math.round(x.r / x.n), Math.round(x.g / x.n), Math.round(x.b / x.n)];
      const share = x.n / total;
      // Ранг — не чистая доля: доля, взвешенная заметностью. Иначе чёрный
      // фон обложки вытесняет из палитры всё остальное.
      return { rgb, share, rank: share * vividness(rgb) };
    })
    .sort((x, y) => y.rank - x.rank);
}

/**
 * @param {string} url обложка
 * @param {string} [cacheKey] обычно id трека
 * @param {HTMLImageElement} [ready] уже отрисованная на экране обложка.
 *   Если она есть — берём пиксели прямо из неё. Свой `new Image()` с тем же
 *   адресом заставляет браузер декодировать JPEG второй раз: на телефоне это
 *   отдельная задача на полторы сотни миллисекунд ровно в момент показа
 *   карточки ответа.
 * @returns {Promise<Array<{css:string, share:number}>|null>}
 *   цвета по убыванию доли; share — доля пикселей обложки (0..1)
 */
export function extractPalette(url, cacheKey = url, ready = null) {
  if (!url) return Promise.resolve(null);
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));

  return new Promise((resolve) => {
    const usable = ready && ready.complete && ready.naturalWidth > 0;
    const img = usable ? ready : new Image();
    if (!usable) {
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
    }

    const fail = () => {
      cache.set(cacheKey, null);
      resolve(null);
    };

    const run = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

        const ranked = quantize(data);
        if (ranked.length === 0) return fail();

        // Берём самые крупные корзины, но не три оттенка одного цвета:
        // соседние корзины схлопываются в ту, что крупнее, и её доля растёт.
        const chosen = [];
        for (const c of ranked) {
          if (chosen.length >= COUNT) break;
          const near = chosen.find((p) => distance(p.rgb, c.rgb) < MIN_DISTANCE);
          if (near) near.share += c.share;
          else chosen.push({ rgb: c.rgb, share: c.share });
        }
        // Почти монохромная обложка: добираем тем же цветом, чтобы получить
        // три точки для градиента.
        while (chosen.length < COUNT && chosen.length) {
          chosen.push({ ...chosen[chosen.length - 1] });
        }

        const out = chosen.map((c) => {
          const [r, g, b] = fitForBg(c.rgb);
          return { css: `rgb(${r} ${g} ${b})`, share: Number(c.share.toFixed(3)) };
        });
        cache.set(cacheKey, out);
        resolve(out);
      } catch {
        // canvas tainted или getImageData запрещён — фон останется нейтральным
        fail();
      }
    };

    if (usable) {
      run();
      return;
    }
    img.onerror = fail;
    img.onload = run;
    img.src = url;
  });
}
