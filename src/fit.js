/**
 * Адаптивная деградация по ВЫСОТЕ вьюпорта.
 *
 * Требование: ни один экран не скроллится. Ширина здесь ни при чём — экран
 * перестаёт помещаться именно по высоте, в том числе когда пользователь зумит
 * страницу (зум уменьшает innerHeight в CSS-пикселях). Поэтому это JS-наблюдатель,
 * а не media query по ширине.
 *
 * Наблюдатель выставляет на <html> атрибут data-dense = 0..4, а CSS по нему
 * прячет второстепенное в строгом порядке:
 *   1 → декоративные полоски и линейки
 *   2 → счётчик уровней в шапке
 *   3 → подписи под иконками и вторичные пояснения
 *   4 → второй лидерборд
 *
 * Никогда не прячется: кнопка воспроизведения, поле поиска, кнопка пропуска,
 * текущий счёт, индикатор ступени. Это зафиксировано в CSS комментарием
 * и проверяется скриптом scripts/verify-noscroll.mjs.
 *
 * Пороги живут в tokens.css (--h-threshold-1..4), чтобы дизайн-токены
 * оставались единственным источником значений.
 */

const LEVELS = 4;

function readThresholds() {
  const cs = getComputedStyle(document.documentElement);
  const out = [];
  for (let i = 1; i <= LEVELS; i++) {
    const raw = cs.getPropertyValue(`--h-threshold-${i}`).trim();
    const n = parseFloat(raw);
    out.push(Number.isFinite(n) ? n : [820, 720, 640, 560][i - 1]);
  }
  return out;
}

let thresholds = null;
let current = -1;

function compute(h) {
  if (!thresholds) thresholds = readThresholds();
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (h < thresholds[i]) level = i + 1;
  }
  return level;
}

function apply() {
  const h = window.innerHeight;
  const level = compute(h);
  if (level === current) return;
  current = level;
  document.documentElement.dataset.dense = String(level);
}

/** Запускает наблюдение. Возвращает функцию отписки. */
export function watchViewportHeight() {
  apply();
  let raf = 0;
  const onResize = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  };
  window.addEventListener('resize', onResize, { passive: true });
  // Зум в некоторых браузерах не даёт resize, но меняет visualViewport.
  window.visualViewport?.addEventListener('resize', onResize, { passive: true });
  return () => {
    window.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    cancelAnimationFrame(raf);
  };
}

/** Текущий уровень плотности 0..4 — на случай, если он нужен логике. */
export function densityLevel() {
  return current;
}
