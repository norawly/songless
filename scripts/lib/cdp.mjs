/**
 * Минимальный клиент Chrome DevTools Protocol поверх WebSocket.
 * Используется и скриншотами, и проверкой «ноль скроллинга»,
 * чтобы не дублировать запуск браузера в двух местах.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ port = 9333, profile }) {
  await rm(profile, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      target = (await res.json()).find((t) => t.type === 'page');
    } catch { /* ещё не поднялся */ }
  }
  if (!target) {
    chrome.kill();
    throw new Error('Chrome не поднялся на отладочном порту');
  }

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  cdp.close = async () => {
    cdp._raw.close();
    chrome.kill();
    // Chrome дописывает профиль ещё пару сотен миллисекунд после kill.
    await new Promise((res) => chrome.once('exit', res));
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return cdp;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  return { send, _raw: ws };
}

/** Выполняет выражение в странице и ждёт промис. */
export async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

export async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: false,
  });
}

/* ------------------------------------------------------------------ */
/* Сценарии прохождения партии — общие для скриншотов и проверок        */
/* ------------------------------------------------------------------ */

export const SCRIPTS = {
  /** Дождаться загрузки каталога. */
  ready: `
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('[data-start]')) return 'ok';
      await new Promise(r => setTimeout(r, 100));
    }
    return 'timeout';
  `,

  /** Стартовать партию и дождаться первого раунда (предзагрузка 5 треков). */
  toRound: `
    const g = () => window.__tapAnda.game;
    document.querySelector('[data-start]').click();
    for (let i = 0; i < 150; i++) {
      if (g().screen === 'round') break;
      await new Promise(r => setTimeout(r, 200));
    }
    document.querySelector('[data-play]')?.click();
    await new Promise(r => setTimeout(r, 400));
    const inp = document.getElementById('answer-input');
    inp.focus(); inp.value = 'сен';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return g().screen;
  `,

  /** Дойти до карточки результата раунда. */
  toReveal: `
    const g = () => window.__tapAnda.game;
    document.querySelector('[data-start]').click();
    for (let i = 0; i < 150; i++) {
      if (g().screen === 'round') break;
      await new Promise(r => setTimeout(r, 200));
    }
    document.querySelector('[data-play]')?.click();
    await new Promise(r => setTimeout(r, 300));
    g().guess(g().track);
    await new Promise(r => setTimeout(r, 1800));
    return g().screen;
  `,

  /** Пройти партию целиком до финала. */
  toFinal: `
    const g = () => window.__tapAnda.game;
    document.querySelector('[data-start]').click();
    for (let i = 0; i < 150; i++) {
      if (g().screen === 'round') break;
      await new Promise(r => setTimeout(r, 200));
    }
    for (let n = 0; n < 5; n++) {
      if (n === 3) {
        for (let k = 0; k < 7; k++) {
          document.querySelector('[data-skip]')?.click();
          await new Promise(r => setTimeout(r, 30));
        }
      } else {
        for (let k = 0; k < n; k++) {
          document.querySelector('[data-skip]')?.click();
          await new Promise(r => setTimeout(r, 30));
        }
        g().guess(g().track);
      }
      await new Promise(r => setTimeout(r, 250));
      document.querySelector('[data-next]')?.click();
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => setTimeout(r, 1500));
    return g().screen;
  `,

  /** Открыть оверлей правил. */
  rules: `
    document.querySelector('[data-rules]').click();
    await new Promise(r => setTimeout(r, 500));
    return 'rules';
  `,
};
