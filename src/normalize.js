/**
 * Нормализация казахской орфографии для поиска.
 *
 * Задача: «Qara Bala», «Қара бала», «кара бала», «qara-bala» — одна и та же строка.
 * Поэтому строим два представления:
 *   norm(s)     — читаемая латиница, для подсветки и отладки;
 *   foldKey(s)  — агрессивно свёрнутый ключ, по нему идёт матчинг.
 *
 * Модуль работает и в браузере, и в Node (используется build-catalog.mjs).
 */

const CYR = {
  а: 'a', ә: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', қ: 'k', л: 'l', м: 'm', н: 'n',
  ң: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ұ: 'u',
  ү: 'u', ф: 'f', х: 'h', һ: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', і: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Кириллица → латиница + снятие диакритики. Регистр теряется. */
export function norm(input) {
  if (!input) return '';
  let s = String(input).toLowerCase();
  let out = '';
  for (const ch of s) out += ch in CYR ? CYR[ch] : ch;
  // ä ö ü ğ ş ç ñ ı и прочая латинская диакритика -> базовая буква
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/ı/g, 'i').replace(/ŋ/g, 'n').replace(/ə/g, 'a');
  return out.replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Свёрнутый ключ: гасит все типовые разночтения казахской латиницы
 * (q/k, j/zh, y/i, w/v, ş/sh/s, ç/ch/c) и удвоения букв.
 */
export function foldKey(input) {
  let s = norm(input);
  s = s
    .replace(/q/g, 'k')
    .replace(/x/g, 'h')
    .replace(/w/g, 'v')
    .replace(/j/g, 'zh')
    .replace(/shch/g, 'sh')
    .replace(/zh/g, 'j')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'c')
    .replace(/ts/g, 'c')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** Ключ без пробелов — для сравнения «одним куском». */
export function tightKey(input) {
  return foldKey(input).replace(/ /g, '');
}

/** Расстояние Левенштейна с ранним выходом по порогу. */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

/** Триграммы строки (с граничными маркерами). */
export function trigrams(s) {
  const p = `  ${s} `;
  const set = new Set();
  for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
  return set;
}

/** Коэффициент Жаккара по триграммам: 0..1. */
export function trigramSim(a, b) {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
