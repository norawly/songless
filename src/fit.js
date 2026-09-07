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
 *
 * Здесь же живёт вторая мера — ВИДИМАЯ высота вьюпорта (--vvh). На телефоне
 * это не одно и то же: открытая клавиатура не меняет ни innerHeight, ни
 * 100dvh, но забирает половину экрана. Разница между ними и есть признак
 * открытой клавиатуры (data-kb), по которому экран раунда ужимается.
 */

const LEVELS = 4;

/**
 * Телефон меряется своей линейкой.
 *
 * Десктопные пороги (820/720/640/560) написаны для окна, которое стало
 * низким: там всё лежит в две-три колонки и вертикали нужно много. Телефон
 * при 812 px высоты формально попадает под первый порог сразу — и терял
 * секунды на шкале ступеней, хотя места на них полно: раскладка-то в одну
 * колонку. Поэтому при узком экране планка опускается.
 */
const MOBILE_MAX_WIDTH = 760;
const MOBILE_THRESHOLDS = [700, 620, 560, 500];

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
  const scale = window.innerWidth <= MOBILE_MAX_WIDTH ? MOBILE_THRESHOLDS : thresholds;
  let level = 0;
  for (let i = 0; i < scale.length; i++) {
    if (h < scale[i]) level = i + 1;
  }
  return level;
}

/** Порог «клавиатура открыта»: меньшие расхождения даёт панель адреса. */
const KEYBOARD_MIN_PX = 120;

function apply() {
  const root = document.documentElement;
  const h = window.innerHeight;

  // Видимая высота и признак клавиатуры — каждый кадр, они дешёвые.
  const vv = window.visualViewport;
  const visible = vv ? vv.height : h;
  root.style.setProperty('--vvh', `${Math.round(visible)}px`);
  const kb = h - visible > KEYBOARD_MIN_PX ? '1' : '0';
  if (root.dataset.kb !== kb) root.dataset.kb = kb;

  const level = compute(h);
  if (level === current) return;
  current = level;
  root.dataset.dense = String(level);
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
  // Прокрутка визуального вьюпорта случается, когда браузер сам подвигает
  // страницу к сфокусированному полю: высота при этом тоже уточняется.
  window.visualViewport?.addEventListener('scroll', onResize, { passive: true });
  return () => {
    window.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('scroll', onResize);
    cancelAnimationFrame(raf);
  };
}

/** Текущий уровень плотности 0..4 — на случай, если он нужен логике. */
export function densityLevel() {
  return current;
}
