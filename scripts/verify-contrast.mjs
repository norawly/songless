#!/usr/bin/env node
/**
 * Проверка контраста токенов по WCAG 2.1.
 *
 * Итерация 2: тема только тёмная — светлой в проекте больше нет, поэтому
 * проверяется один набор значений.
 *
 * Требования из брифа: основной текст ≥ 7:1 (AAA), вторичный ≥ 4.5:1,
 * акцент под текст ≥ 4.5:1, границы контролов ≥ 3:1.
 *
 * Значения парсятся прямо из styles/tokens.css, чтобы проверка не разъезжалась
 * с реальными токенами.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = await readFile(join(ROOT, 'styles', 'tokens.css'), 'utf8');

/** Собирает карту переменных из указанного блока селектора. */
function varsFrom(block) {
  const map = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) map[m[1]] = m[2].trim();
  return map;
}

function blockFor(selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`не найден блок ${selector}`);
  const start = css.indexOf('{', i);
  let depth = 0;
  for (let k = start; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, k);
    }
  }
  throw new Error(`не закрыт блок ${selector}`);
}

const dark = varsFrom(blockFor(':root {'));

/** Разворачивает var(--x) до hex. */
function resolve(theme, value, depth = 0) {
  if (depth > 10) throw new Error('циклическая ссылка в токенах');
  const v = String(value).trim();
  const m = v.match(/^var\((--[\w-]+)\)$/);
  if (m) return resolve(theme, theme[m[1]], depth + 1);
  return v;
}

function toRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** [токен-переднего-плана, токен-фона, минимум, описание] */
const CHECKS = [
  ['--color-text-primary', '--color-bg-primary', 7, 'основной текст на фоне (AAA)'],
  ['--color-text-primary', '--color-bg-secondary', 7, 'основной текст на карточке'],
  ['--color-text-primary', '--color-bg-tertiary', 7, 'основной текст в поле ввода'],
  ['--color-text-secondary', '--color-bg-primary', 4.5, 'вторичный текст (AA)'],
  ['--color-text-secondary', '--color-bg-secondary', 4.5, 'вторичный текст на карточке'],
  ['--color-text-tertiary', '--color-bg-primary', 3, 'плейсхолдер/подсказка (крупн./неткст)'],
  ['--color-accent-primary', '--color-bg-primary', 4.5, 'акцентный текст на фоне'],
  ['--color-accent-on', '--color-accent-primary', 4.5, 'текст на акцентной кнопке'],
  ['--color-border-focus', '--color-bg-primary', 3, 'кольцо фокуса'],
  ['--color-border-primary', '--color-bg-primary', 1.8, 'обычная граница (декоративная)'],
  ['--color-border-strong', '--color-bg-primary', 3, 'сильная граница / UI-компонент'],
  ['--color-text-inverse', '--color-bg-inverse', 7, 'тост: текст на инверсном фоне'],
  ['--color-status-error', '--color-bg-primary', 4.5, 'ошибка'],
  ['--color-status-success', '--color-bg-primary', 4.5, 'успех'],
];

let failed = 0;
console.log('\n=== Тёмная тема (единственная) ===');
for (const [fg, bg, min, label] of CHECKS) {
  const c1 = resolve(dark, `var(${fg})`);
  const c2 = resolve(dark, `var(${bg})`);
  const r = ratio(c1, c2);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${r.toFixed(2).padStart(6)}:1 (нужно ${String(min).padStart(4)}) ` +
      `${label}  [${c1} / ${c2}]`
  );
}

// Светлой темы быть не должно — задание требует её полного удаления.
if (/data-theme="light"|prefers-color-scheme:\s*light/.test(css)) {
  console.log(' FAIL  в tokens.css остались следы светлой темы');
  failed++;
} else {
  console.log('  ok   следов светлой темы в токенах нет');
}

console.log(failed === 0 ? '\nКонтраст в норме.\n' : `\n${failed} нарушений контраста.\n`);
process.exit(failed === 0 ? 0 : 1);
