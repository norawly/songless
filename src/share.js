/**
 * Шеринг результата в стиле Wordle: emoji-сетка, которая читается в любом
 * мессенджере и не выдаёт названий песен — чужую партию она не портит.
 *
 * Строка = раунд, клетка = ступень прослушивания:
 *   🟩 угадал на этой ступени
 *   ⬛ ступень потрачена (пропуск или неверный ответ)
 *   ⬜ до этой ступени не дошло
 */

import { STEPS } from './scoring.js';
import { t } from './i18n.js';
import { CONFIG } from './config.js';
import { fmtNum } from './ui.js';

const KEYCAP = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

export function buildGrid(results) {
  return results
    .map((r, i) => {
      const cells = [];
      for (let s = 0; s < STEPS; s++) {
        if (r.solved && s === r.stepIndex) cells.push('🟩');
        else if (s <= r.stepIndex) cells.push('⬛');
        else cells.push('⬜');
      }
      return `${KEYCAP[i] || ''} ${cells.join('')}`;
    })
    .join('\n');
}

/** Полный текст для буфера обмена / нативного шеринга. */
export function buildShareText(results, total, verdict) {
  const lines = [
    `${t('app.title')} · ${fmtNum(total)} ${t('reveal.points')}`,
    verdict,
    '',
    buildGrid(results),
  ];
  if (CONFIG.SHARE_URL) lines.push('', `🎧 ${CONFIG.SHARE_URL}`);
  return lines.join('\n');
}

/** Копирование с запасным вариантом для браузеров без Clipboard API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Нативный шеринг там, где он есть (мобильные). */
export function canShareNatively() {
  return typeof navigator.share === 'function';
}

export async function shareNatively(text) {
  try {
    await navigator.share({ title: t('app.title'), text });
    return true;
  } catch {
    return false;
  }
}
