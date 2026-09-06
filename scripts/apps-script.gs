/**
 * ТАП ӘНДІ — лидерборды на Google Apps Script + Google Sheets.
 *
 * Это единственный «сервер» проекта. Сайт статичный, поэтому вся проверка
 * результата обязана происходить здесь: клиентская валидация против намеренного
 * читера не работает в принципе (см. SCORING.md §1.4).
 *
 * Сервисный аккаунт с JSON-ключом здесь применять нельзя — на статическом сайте
 * ключ оказался бы в исходнике. Apps Script Web App с доступом «Anyone» не
 * требует никаких ключей на клиенте, только URL.
 *
 * Пошаговая инструкция по установке — в SETUP.md.
 *
 * Эндпоинты:
 *   GET  ?action=top&limit=7   → { ok:true, allTime:[...], today:[...] }
 *   POST { action:'submit', … } → { ok:true, rank:N } либо { ok:false, error }
 *
 * ВАЖНО про CORS: Apps Script не обрабатывает preflight (OPTIONS), поэтому
 * клиент шлёт POST с Content-Type: text/plain;charset=utf-8 — это «простой»
 * CORS-запрос, для которого preflight не нужен. Тело всё равно JSON и читается
 * из e.postData.contents.
 */

/* ====================================================================== */
/* Настройки                                                              */
/* ====================================================================== */

/** Имя листа, куда пишутся результаты. Создастся автоматически. */
var SHEET_NAME = 'scores';

/** Теоретический максимум за партию. Должен совпадать с MAX_GAME_SCORE
 *  в src/scoring.js (5 раундов × 1333). Всё выше — отбрасываем. */
var MAX_GAME_SCORE = 6665;

/** Максимум за один раунд. */
var MAX_ROUND_SCORE = 1333;

/** Раундов в партии. */
var ROUNDS = 5;

/** Сколько строк отдавать по умолчанию в каждом топе. */
var DEFAULT_TOP = 7;

/** Часовой пояс, по которому считается «сегодня». */
var TIMEZONE = 'Asia/Almaty';

/** Не чаще одной отправки в N секунд с одного sessionHash. */
var RATE_LIMIT_SECONDS = 20;

/** Одна сессия = одна запись. Поставь false, чтобы разрешить несколько партий. */
var ONE_SUBMIT_PER_SESSION = true;

/** Корни нецензурной лексики. Дублируют список из src/leaderboard.js:
 *  клиенту доверять нельзя, фильтр обязан работать и на сервере. */
var PROFANITY = [
  'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебал', 'ебан', 'ебуч', 'еблан',
  'бляд', 'блять', 'сука', 'мудак', 'мудил', 'гандон', 'пидор', 'пидар',
  'залуп', 'дроч', 'манда', 'ублюд', 'шлюх', 'нахуй', 'похуй',
  'котак', 'котақ', 'амжырт', 'амшелек', 'сікт', 'енең', 'енен',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'nigg', 'asshole', 'whore'
];

/* ====================================================================== */
/* Точки входа                                                            */
/* ====================================================================== */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action === 'top' || !params.action) {
      var limit = clampInt(params.limit, 1, 200, DEFAULT_TOP);
      var boards = readBoards(limit);
      return json({ ok: true, allTime: boards.allTime, today: boards.today });
    }
    return json({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  // Блокировка: две одновременные отправки не должны затереть друг друга.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty-body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return json({ ok: false, error: 'bad-json' });
    }

    if (body.action !== 'submit') return json({ ok: false, error: 'unknown-action' });

    var check = validate(body);
    if (!check.ok) return json(check);

    var sheet = getSheet();
    var sessionHash = String(body.sessionHash || '').slice(0, 64);

    var recent = findRecentBySession(sheet, sessionHash);
    if (recent) {
      if (ONE_SUBMIT_PER_SESSION) return json({ ok: false, error: 'already-submitted' });
      var ageSec = (new Date().getTime() - recent.getTime()) / 1000;
      if (ageSec < RATE_LIMIT_SECONDS) return json({ ok: false, error: 'rate-limited' });
    }

    sheet.appendRow([
      new Date(),                // A. время записи на сервере (авторитетное)
      check.nick,                // B. ник (санитизированный)
      check.score,               // C. общий счёт
      check.roundsText,          // D. разбивка по раундам
      sessionHash,               // E. хэш сессии
      String(body.date || ''),   // F. время по часам клиента (справочно)
      String(body.v || '')       // G. версия клиента
    ]);

    return json({ ok: true, rank: rankOf(check.score) });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ====================================================================== */
/* Валидация — единственная настоящая защита в системе                    */
/* ====================================================================== */

function validate(body) {
  var nick = sanitizeNick(body.nick);
  if (nick.length < 2) return { ok: false, error: 'nick-too-short' };
  if (hasProfanity(nick)) return { ok: false, error: 'nick-bad' };

  var score = body.score;
  if (typeof score !== 'number' || !isFinite(score)) return { ok: false, error: 'bad-score' };
  if (score !== Math.floor(score)) return { ok: false, error: 'bad-score' };
  if (score < 0) return { ok: false, error: 'negative-score' };
  if (score > MAX_GAME_SCORE) return { ok: false, error: 'impossible-score' };

  var rounds = body.rounds;
  if (!rounds || rounds.length !== ROUNDS) return { ok: false, error: 'bad-rounds' };

  var sum = 0;
  var parts = [];
  for (var i = 0; i < rounds.length; i++) {
    var r = rounds[i] || {};
    var p = r.points;
    if (typeof p !== 'number' || !isFinite(p) || p !== Math.floor(p)) {
      return { ok: false, error: 'bad-round-points' };
    }
    if (p < 0 || p > MAX_ROUND_SCORE) return { ok: false, error: 'impossible-round' };

    var step = r.step;
    if (typeof step !== 'number' || step < 1 || step > 7) return { ok: false, error: 'bad-step' };
    // Раунд не может стоить больше потолка своей ступени.
    if (p > maxForStep(step)) return { ok: false, error: 'round-exceeds-step-cap' };
    // Непойманный раунд обязан быть нулевым.
    if (r.solved === false && p !== 0) return { ok: false, error: 'unsolved-with-points' };

    sum += p;
    parts.push(r.level + ':' + step + ':' + p + (r.solved ? '+' : '-'));
  }

  if (sum !== score) return { ok: false, error: 'sum-mismatch' };
  return { ok: true, nick: nick, score: score, roundsText: parts.join(' | ') };
}

/** Потолок раунда для ступени: STEP_POINTS[step-1] × (1 + 1/3). */
function maxForStep(step) {
  var STEP_POINTS = [1000, 700, 500, 350, 250, 175, 120];
  return Math.round(STEP_POINTS[step - 1] * (4 / 3));
}

/**
 * Санитизация ника. Отдельно глушим formula injection: Google Sheets исполняет
 * ячейку, начинающуюся с = + - @, как формулу.
 */
function sanitizeNick(raw) {
  var s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.substring(0, 20);
  s = s.replace(/^[=+\-@]+/, '');
  return s.trim();
}

/** Порядок важен: цифры-подмены разворачиваем ДО удаления небуквенного. */
function hasProfanity(nick) {
  var flat = String(nick || '').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-zЀ-ӿ]/g, '');
  for (var i = 0; i < PROFANITY.length; i++) {
    if (flat.indexOf(PROFANITY[i]) !== -1) return true;
  }
  return false;
}

/* ====================================================================== */
/* Работа с таблицей                                                      */
/* ====================================================================== */

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['server_time', 'nick', 'score', 'rounds', 'session', 'client_date', 'v']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRecentBySession(sheet, sessionHash) {
  if (!sessionHash) return null;
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var n = Math.min(500, last - 1); // смотрим только хвост — этого достаточно
  var values = sheet.getRange(last - n + 1, 1, n, 5).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][4]) === sessionHash) return new Date(values[i][0]);
  }
  return null;
}

/** Строка «сегодня» в часовом поясе TIMEZONE. */
function dayKey(date) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Оба топа за один проход по таблице.
 * «Сегодня» считается по серверному времени записи в TIMEZONE, а не по часам
 * клиента: клиентское время подделывается тривиально.
 */
function readBoards(limit) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { allTime: [], today: [] };

  var values = sheet.getRange(2, 1, last - 1, 3).getValues(); // время, ник, счёт
  var todayKey = dayKey(new Date());
  var all = [];
  var today = [];

  for (var i = 0; i < values.length; i++) {
    var score = Number(values[i][2]);
    // мусор в таблице (ручные правки, старые версии) просто пропускаем
    if (!isFinite(score) || score < 0 || score > MAX_GAME_SCORE) continue;
    var when = values[i][0] ? new Date(values[i][0]) : null;
    var row = {
      nick: String(values[i][1]),
      score: score,
      date: when ? when.toISOString() : ''
    };
    all.push(row);
    if (when && dayKey(when) === todayKey) today.push(row);
  }

  // При равенстве очков выше тот, кто поставил результат раньше.
  var byScore = function (a, b) {
    return b.score - a.score || (a.date < b.date ? -1 : 1);
  };
  all.sort(byScore);
  today.sort(byScore);

  return { allTime: all.slice(0, limit), today: today.slice(0, limit) };
}

function rankOf(score) {
  var rows = readBoards(100000).allTime;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].score <= score) return i + 1;
  }
  return rows.length + 1;
}

/* ====================================================================== */
/* Утилиты                                                                */
/* ====================================================================== */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clampInt(v, min, max, fallback) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ====================================================================== */
/* Ручная проверка из редактора Apps Script (Run → testEndpoints)         */
/* ====================================================================== */

function testEndpoints() {
  function post(nick, score, rounds) {
    return doPost({
      postData: {
        contents: JSON.stringify({
          action: 'submit', nick: nick, score: score, rounds: rounds,
          sessionHash: 'test-' + Math.random(), date: new Date().toISOString(), v: 2
        })
      }
    }).getContent();
  }

  var good = [
    { level: 1, step: 1, points: 1333, solved: true },
    { level: 2, step: 7, points: 0, solved: false },
    { level: 3, step: 7, points: 0, solved: false },
    { level: 4, step: 7, points: 0, solved: false },
    { level: 5, step: 7, points: 0, solved: false }
  ];

  // 1. Честная запись — должно быть ok:true
  Logger.log('честный:      ' + post('=HYPERLINK("evil")  Тест', 1333, good));

  // 2. Оба топа
  Logger.log('топы:         ' + doGet({ parameter: { action: 'top', limit: '5' } }).getContent());

  // 3. Счёт выше максимума — должно быть impossible-score
  var cheat = [1, 2, 3, 4, 5].map(function (l) {
    return { level: l, step: 1, points: 199999, solved: true };
  });
  Logger.log('накрутка:     ' + post('cheater', 999999, cheat));

  // 4. Мат в нике — должно быть nick-bad
  Logger.log('мат в нике:   ' + post('сука', 1333, good));

  // 5. Сумма раундов не сходится — должно быть sum-mismatch
  Logger.log('sum-mismatch: ' + post('Тест2', 5000, good));
}
