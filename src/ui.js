/**
 * Мелкие DOM-помощники. Никакого фреймворка: экранов пять, состояние простое,
 * и 6 КБ рантайма здесь дешевле любой библиотеки.
 */

import { t } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Экранирование для вставки в шаблонные строки. Названия треков — чужой текст. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, html = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (html) node.innerHTML = html;
  return node;
}

/* ------------------------------------------------------------------ */
/* Оверлей (правила / лидерборд / шеринг) — одна реализация на все три  */
/* ------------------------------------------------------------------ */

let openSheet = null;

export function sheet({ title, bodyHtml, onMount, wide = false }) {
  closeSheet();

  const backdrop = el('div', { class: 'sheet-backdrop', 'data-sheet': '' });
  const panel = el('div', {
    class: wide ? 'sheet sheet--wide' : 'sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  });
  panel.innerHTML = `
    <div class="sheet__head">
      <h2 class="sheet__title">${esc(title)}</h2>
      <button class="btn btn--icon" data-close aria-label="${esc(t('nav.close'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
    </div>
    <div class="sheet__body">${bodyHtml}</div>`;

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  document.body.classList.add('is-locked');

  const lastFocused = document.activeElement;

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = $$(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      panel
    ).filter((n) => n.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) closeSheet();
  });
  document.addEventListener('keydown', onKey);

  openSheet = {
    node: backdrop,
    cleanup() {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('is-locked');
      backdrop.remove();
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    },
  };

  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    const target = $('[data-autofocus]', panel) || $('[data-close]', panel);
    target?.focus();
  });

  onMount?.(panel);
  return panel;
}

export function closeSheet() {
  if (!openSheet) return;
  openSheet.cleanup();
  openSheet = null;
}

/* ------------------------------------------------------------------ */
/* Тост — короткая нейтральная подсказка                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;

export function toast(message, tone = 'neutral') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2600);
}

/* ------------------------------------------------------------------ */
/* Анимация счёта                                                      */
/* ------------------------------------------------------------------ */

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function animateCount(node, to, durationMs = 900) {
  const target = Math.round(to);
  if (reduceMotion() || target === 0) {
    node.textContent = fmtNum(target);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / durationMs);
    // easeOutExpo: быстро набирает, мягко останавливается
    const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    node.textContent = fmtNum(target * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export { reduceMotion };

/**
 * Разряды числа.
 * toLocaleString('kk-KZ') в браузерах даёт запятую («2,320»), а в казахском
 * разделитель разрядов — пробел. Поэтому форматируем сами, узким неразрывным
 * пробелом, чтобы число не переносилось.
 */
export function fmtNum(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

/** Строка вида «1 мс» / «0,5 с» / «16 с» для длительности ступени. */
export function formatStepDuration(ms) {
  const s = ms / 1000;
  return `${String(s).replace('.', ',')} с`;
}
