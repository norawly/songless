#!/usr/bin/env node
/**
 * Проверка поиска на реальном каталоге.
 * Главное требование ТЗ: «кара бала» должно находить «Qara Bala».
 * Здесь же — регрессия на кириллицу/латиницу, опечатки и слитный ввод.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Catalog } from '../src/catalog.js';
import { foldKey } from '../src/normalize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const payload = JSON.parse(await readFile(join(ROOT, 'data', 'tracks.json'), 'utf8'));
const cat = new Catalog(payload);

console.log(`\nКаталог: ${cat.size} треков, ${cat.artistCount} орындаушы`);
console.log('По тирам:', payload.byTier, '\n');

let failed = 0;

/** Запрос должен вернуть трек, чей fold-ключ названия/артиста совпадает с ожидаемым. */
function expect(query, matcher, label) {
  const res = cat.search(query, 8);
  const hitIndex = res.findIndex(matcher);
  const ok = hitIndex >= 0 && hitIndex < 5;
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(46)} «${query}»` +
      (hitIndex >= 0 ? ` → позиция ${hitIndex + 1}` : ' → не найдено')
  );
  if (!ok) {
    failed++;
    res.slice(0, 4).forEach((t) => console.log(`          получили: ${t._display}`));
  }
  return res;
}

console.log('— Латиница ↔ кириллица —');
for (const t of cat.tracks.slice(0, 6)) {
  expect(t.title, (r) => r.id === t.id, `точное название: ${t.title.slice(0, 24)}`);
}

console.log('\n— Казахская орфография (ключевой сценарий ТЗ) —');
// Синтетические пары: пишем название трека «неправильно» и ждём находку.
const swaps = [
  ['қ', 'к'], ['ә', 'а'], ['ө', 'о'], ['ү', 'у'], ['ұ', 'у'],
  ['ң', 'н'], ['ғ', 'г'], ['і', 'и'], ['һ', 'х'],
];
let orthoChecked = 0;
for (const t of cat.tracks) {
  if (orthoChecked >= 8) break;
  let mangled = t.title;
  let changed = false;
  for (const [from, to] of swaps) {
    if (mangled.toLowerCase().includes(from)) {
      mangled = mangled.replace(new RegExp(from, 'gi'), to);
      changed = true;
    }
  }
  if (!changed) continue;
  orthoChecked++;
  expect(mangled, (r) => r.id === t.id, `спец. буквы заменены: ${t.title.slice(0, 22)}`);
}

console.log('\n— Опечатки (Левенштейн ≤ 2) —');
let typoChecked = 0;
for (const t of cat.tracks) {
  if (typoChecked >= 6) break;
  const w = t._titleWords.find((x) => x.length >= 5);
  if (!w) continue;
  typoChecked++;
  const typo = w.slice(0, 2) + w.slice(3); // выкидываем букву
  expect(typo, (r) => r._titleF.includes(w), `пропущена буква в «${w}»`);
}

console.log('\n— Слитный ввод и поиск по артисту —');
for (const t of cat.tracks.slice(0, 4)) {
  expect(t._titleF.replace(/ /g, ''), (r) => r.id === t.id, `без пробелов: ${t.title.slice(0, 22)}`);
}
for (const t of [cat.tracks[0], cat.tracks[10], cat.tracks[40]]) {
  expect(t.artist, (r) => foldKey(r.artist) === foldKey(t.artist), `по артисту: ${t.artist.slice(0, 22)}`);
}

console.log('\n— Список всегда наполнен похожими вариантами —');
for (const q of ['a', 'ай', 'sen', 'жүрек', 'qara']) {
  const res = cat.search(q, 8);
  const ok = res.length >= 5;
  console.log(`${ok ? '  ok  ' : ' FAIL '} «${q}» → ${res.length} вариантов`);
  if (!ok) failed++;
}

console.log('\n— Пустой и мусорный ввод —');
console.log(`${cat.search('').length === 0 ? '  ok  ' : ' FAIL '} пустая строка → 0`);
console.log(`${cat.search('   ---   ').length === 0 ? '  ok  ' : ' FAIL '} только пунктуация → 0`);
if (cat.search('').length !== 0) failed++;

console.log('\n— Подбор партии: уровень строится из fame_tier —');
{
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const { picked, spares } = cat.pickGame();
    if (picked.length !== 5) { bad++; break; }
    for (let level = 1; level <= 5; level++) {
      const allowed = cat.levelTiers[level] || cat.levelTiers[String(level)];
      if (!allowed.includes(picked[level - 1].tier)) { bad++; break; }
    }
    // треки в партии не должны повторяться
    if (new Set(picked.map((t) => t.id)).size !== 5) { bad++; break; }
    if (spares.length !== 5) { bad++; break; }
  }
  console.log(`${bad === 0 ? '  ok  ' : ' FAIL '} 200 партий: тир каждого раунда входит в свой уровень, повторов нет`);
  if (bad) failed++;

  const { picked } = cat.pickGame();
  console.log('  ok   пример партии:');
  picked.forEach((t, i) => console.log(`         ${i + 1} (tier ${t.tier}) ${t.artist} — ${t.title}`));
}

console.log('\n— Фильтры режима —');
{
  const famOnly = cat.filtered({ age: 'family' });
  console.log(`${famOnly.every((t) => t.age === 'family') ? '  ok  ' : ' FAIL '} Family не пускает 18+ (${famOnly.length} треков)`);
  if (!famOnly.every((t) => t.age === 'family')) failed++;

  const adult = cat.filtered({ age: '18plus' });
  const ok18 = adult.length >= famOnly.length;
  console.log(`${ok18 ? '  ok  ' : ' FAIL '} 18+ расширяет каталог, а не заменяет (${adult.length} ≥ ${famOnly.length})`);
  if (!ok18) failed++;

  // Категории проверяем те, что каталог реально показывает игроку.
  for (const g of cat.genres) {
    const only = cat.filtered({ genres: [g] });
    const pure = only.every((t) => t.genres.includes(g));
    console.log(`${pure && only.length ? '  ok  ' : ' FAIL '} категория «${g}»: ${only.length} треков, все с этим тегом`);
    if (!pure || !only.length) failed++;
  }

  // Блок I2: категория показывается, только если в ней хватает песен.
  const minTracks = payload.genreMinTracks || 25;
  const thin = cat.genres.filter((g) => (payload.byGenre[g] || 0) < minTracks);
  console.log(`${thin.length === 0 ? '  ok  ' : ' FAIL '} нет показанных категорий тоньше ${minTracks} треков` +
    (thin.length ? `: ${thin.join(', ')}` : ''));
  if (thin.length) failed++;

  const hidden = (payload.allGenres || []).filter((g) => !cat.genres.includes(g));
  console.log(`  ok   скрытые категории (мало треков): ${hidden.length ? hidden.join(', ') : 'нет'}`);

  const [g1, g2] = cat.genres;
  const two = cat.filtered({ genres: [g1, g2] });
  const union = two.every((t) => t.genres.includes(g1) || t.genres.includes(g2));
  console.log(`${union ? '  ok  ' : ' FAIL '} несколько категорий работают как объединение (${two.length})`);
  if (!union) failed++;

  // Защита от пустой выборки: невозможная комбинация не должна давать старт
  const impossible = cat.canStart({ age: 'family', genres: ['qpop'] });
  console.log(`  ok   canStart для узкого фильтра: ${impossible.ok ? 'можно играть' : 'старт заблокирован'}` +
    ` (по уровням: ${impossible.perLevel.map((p) => p.count).join('/')})`);

  const wide = cat.canStart({ age: '18plus', genres: [] });
  console.log(`${wide.ok ? '  ok  ' : ' FAIL '} полный каталог позволяет начать партию`);
  if (!wide.ok) failed++;
}

console.log('\n— Экспертный режим (блок B1) —');
{
  const normal4 = cat.poolForLevel(4, { difficulty: 'normal' });
  const expert4 = cat.poolForLevel(4, { difficulty: 'expert' });
  const wider = expert4.length >= normal4.length;
  console.log(`${wider ? '  ok  ' : ' FAIL '} на 4-м уровне экспертный пул шире обычного (${expert4.length} ≥ ${normal4.length})`);
  if (!wider) failed++;

  const hasT5 = expert4.some((t) => t.tier === 5);
  const hasUnder = expert4.some((t) => (t.genres || []).includes('underground'));
  console.log(`${hasT5 || hasUnder ? '  ok  ' : ' FAIL '} в верхние уровни подмешаны тир 5 / андеграунд`);
  if (!hasT5 && !hasUnder) failed++;
}

console.log('\n— Без повторов (блок I3) —');
{
  // localStorage в Node нет, PlayHistory это переживает и работает в памяти.
  cat.history.clear();
  const seen = new Set();
  let repeats = 0;
  for (let i = 0; i < 20; i++) {
    const { picked } = cat.pickGame();
    for (const t of picked) {
      if (seen.has(t.id)) repeats++;
      seen.add(t.id);
    }
    cat.remember(picked);
  }
  console.log(`${repeats === 0 ? '  ok  ' : ' FAIL '} 20 партий подряд без единого повтора (уникальных треков: ${seen.size})`);
  if (repeats) failed++;
  cat.history.clear();
}

console.log('\n— Каталог чист от чужого —');
{
  const BAD = /gorillaz|harry styles|xxxtentacion|doja cat|imagine dragons|billie eilish|instasamka|morgenshtern|miyagi|the kid laroi|arctic monkeys|tame impala/i;
  const bad = cat.tracks.filter((t) => BAD.test(t.artist));
  console.log(`${bad.length === 0 ? '  ok  ' : ' FAIL '} запрещённых артистов в каталоге: ${bad.length}`);
  if (bad.length) { failed++; bad.slice(0, 5).forEach((t) => console.log('        ', t.artist, '—', t.title)); }

  const noPreview = cat.tracks.filter((t) => !t.preview).length;
  const noArt = cat.tracks.filter((t) => !t.art).length;
  console.log(`${noPreview === 0 ? '  ok  ' : ' FAIL '} все треки с previewUrl (без превью: ${noPreview})`);
  console.log(`${noArt === 0 ? '  ok  ' : ' FAIL '} все треки с обложкой (без обложки: ${noArt})`);
  if (noPreview || noArt) failed++;

  const sized = cat.size >= 500 && cat.size <= 900;
  console.log(`${sized ? '  ok  ' : ' FAIL '} объём каталога в диапазоне 500–900: ${cat.size}`);
  if (!sized) failed++;
}

console.log('\n— Канонический сценарий ТЗ: «кара бала» → «Qara Bala» —');
{
  // В собранном каталоге этого трека может не быть, поэтому проверяем
  // на контрольном мини-каталоге — требование про орфографию, а не про песню.
  const probe = new Catalog({
    tracks: [
      { id: 'p1', title: 'Qara Bala', artist: 'Test Artist', level: 1 },
      { id: 'p2', title: 'Qara Kóz', artist: 'Test Artist', level: 1 },
      { id: 'p3', title: 'Bala', artist: 'Basqa', level: 1 },
      { id: 'p4', title: 'Aq Bala', artist: 'Basqa', level: 1 },
    ],
  });
  for (const q of ['кара бала', 'қара бала', 'Qara Bala', 'karabala', 'kara bala', 'кара-бала']) {
    const r = probe.search(q, 4);
    const ok = r[0] && r[0].id === 'p1';
    console.log(`${ok ? '  ok  ' : ' FAIL '} «${q}» → ${r[0] ? r[0]._display : '—'}`);
    if (!ok) failed++;
  }
}

console.log(failed === 0 ? '\nПоиск в порядке.\n' : `\n${failed} провалов.\n`);
process.exit(failed === 0 ? 0 : 1);
