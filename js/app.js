/* app.js — 언어 목록, 설정 저장/복원, 모드 전환, 이벤트 연결, 시작
 * ★ 가장 마지막에 불립니다.
 * 이 파일의 "12. 이벤트 연결" 은 startListening(speech.js),
 * clearCaptions(subtitle.js), runChatTranslation(translate.js) 처럼
 * 다른 파일의 함수를 이름으로 바로 가리킵니다. 그 파일들이 먼저
 * 불려 있어야 하므로 app.js 가 맨 뒤입니다.
 * 맨 끝의 init() 도 같은 이유로 여기 있습니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════
   1. 언어 목록
   speech 항목은 음성 인식에 넘길 코드입니다.
   음성 인식은 "무슨 언어인지" 미리 알려줘야 하므로
   자동 감지를 쓸 수 없습니다.
   ══════════════════════════════════════════════════════════ */
var LANGS = [
  { code: 'ko', name: '한국어',       speech: 'ko-KR' },
  { code: 'en', name: '영어',         speech: 'en-US' },
  { code: 'ja', name: '일본어',       speech: 'ja-JP' },
  { code: 'zh', name: '중국어(간체)', speech: 'zh-CN' },
  { code: 'es', name: '스페인어',     speech: 'es-ES' },
  { code: 'fr', name: '프랑스어',     speech: 'fr-FR' },
  { code: 'de', name: '독일어',       speech: 'de-DE' },
  { code: 'ru', name: '러시아어',     speech: 'ru-RU' },
  { code: 'pt', name: '포르투갈어',   speech: 'pt-BR' },
  { code: 'it', name: '이탈리아어',   speech: 'it-IT' },
  { code: 'id', name: '인도네시아어', speech: 'id-ID' },
  { code: 'nl', name: '네덜란드어',   speech: 'nl-NL' }
];

function langName(code) {
  if (code === 'auto') return '자동 감지';
  for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i].name;
  return code;
}
function speechTag(code) {
  for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i].speech;
  return null;
}

/* ══════════════════════════════════════════════════════════
   3. 사용자 설정 저장/불러오기 (localStorage)
      API 키는 서버 환경변수에 있으므로 여기 저장할 것이 없습니다.
   ══════════════════════════════════════════════════════════ */
var PREF_KEY = 'translator.prefs';

var prefs = {
  source: 'ko',
  target: 'en',
  theme: 'dark',
  capsize: 'm',
  autoTranslate: true,

  /* ── 자막 표시 방식 (2.5단계에서 추가) ────────────────────
     capMode    : 'flow'        지금 방식. 중간 결과가 실시간으로 흘러감
                  'phrase'      확정된 구절만 표시 (기본값)
                  'phrase-live' 확정 구절 + 듣는 중인 한 줄을 따로 표시
     capContent : 'both' 원문+번역 / 'translation' 번역만(기본) / 'source' 원문만
     capLines   : 화면에 유지할 자막 개수 (1~4)
     minHoldMs  : 자막 하나가 최소한 화면에 머무는 시간 (1000~5000) */
  capMode: 'phrase',
  capContent: 'translation',
  capLines: 2,
  minHoldMs: 2000
};

function loadPrefs() {
  try {
    var raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    for (var k in prefs) {
      if (Object.prototype.hasOwnProperty.call(saved, k)) prefs[k] = saved[k];
    }
  } catch (e) { /* 저장소를 막아둔 브라우저에서도 앱이 죽지 않게 */ }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
}

/* ── 오늘 번역에 보낸 글자 수 ── */
var USAGE_KEY = 'translator.usage';
function todayStamp() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function loadUsage() {
  try {
    var u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    if (u.date === todayStamp() && typeof u.chars === 'number') return u;
  } catch (e) {}
  return { date: todayStamp(), chars: 0 };
}
var usage = loadUsage();
function addUsage(n) {
  if (usage.date !== todayStamp()) usage = { date: todayStamp(), chars: 0 };
  usage.chars += n;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) {}
  renderUsage();
}
function renderUsage() {
  var pct = Math.min(100, Math.round(usage.chars / DAILY_CHAR_BUDGET * 100));
  var gauge = $('usageGauge');
  gauge.firstElementChild.style.width = pct + '%';
  gauge.className = 'gauge' + (pct >= 80 ? ' high' : '');
  $('usageText').textContent = usage.chars.toLocaleString() + ' 자  ('
    + pct + '% / 기준 ' + DAILY_CHAR_BUDGET.toLocaleString() + '자)';
}

/* ══════════════════════════════════════════════════════════
   4. 상태 문구
   ══════════════════════════════════════════════════════════ */
var statusTimer = null;
function setStatus(msg, kind, sticky) {
  statusEl.textContent = msg || '';
  statusEl.className = kind || '';
  if (statusTimer) clearTimeout(statusTimer);
  if (msg && !sticky) {
    statusTimer = setTimeout(function () {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 5000);
  }
}

function nowLabel() {
  var d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ══════════════════════════════════════════════════════════
   5. 클립보드 복사
   ══════════════════════════════════════════════════════════ */
function flashText(el, temp) {
  var original = el.textContent;
  el.textContent = temp;
  el.classList.add('copied');
  setTimeout(function () {
    el.textContent = original;
    el.classList.remove('copied');
  }, 1200);
}
function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
async function copyText(text, flashEl) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      flashText(flashEl, '복사했습니다');
      return;
    }
    if (legacyCopy(text)) flashText(flashEl, '복사했습니다');
    else setStatus('복사에 실패했습니다. 직접 선택해서 복사해 주세요.', 'err');
  } catch (e) {
    setStatus('복사에 실패했습니다: ' + e.message, 'err');
  }
}

/* ══════════════════════════════════════════════════════════
   9. 모드 전환
   ══════════════════════════════════════════════════════════ */
var currentMode = 'speak';

function switchMode(mode) {
  // 말하기 모드를 떠날 때는 마이크를 끕니다 (몰래 켜져 있으면 안 되니까요)
  if (currentMode === 'speak' && mode !== 'speak' && listening) {
    stopListening(true);
    setStatus('다른 모드로 넘어가면서 마이크를 껐습니다.', '');
  }
  currentMode = mode;

  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-mode') === mode);
  });
  ['speak', 'chat', 'settings'].forEach(function (m) {
    $('view-' + m).classList.toggle('active', m === mode);
  });

  $('speakBar').classList.toggle('active', mode === 'speak');
  $('chatBar').classList.toggle('active', mode === 'chat');
  langbar.classList.toggle('hidden', mode === 'settings');

  if (mode === 'speak') {
    // 4단계: 지원하지 않는 브라우저에서는 안내 문구를 바꿔 둡니다
    hintEl.textContent = SpeechRecognitionClass
      ? '마이크는 시작을 누른 동안에만 켜집니다.'
      : '채팅 탭에서 글 번역은 정상 동작합니다.';
  } else if (mode === 'chat') {
    hintEl.textContent = 'Enter = 번역 · Shift+Enter = 줄바꿈';
    inputEl.focus();
  } else {
    hintEl.textContent = '';
    renderUsage();
  }
}

/* ══════════════════════════════════════════════════════════
   10. 설정 화면 버튼들
   ══════════════════════════════════════════════════════════ */
function paintChips() {
  document.querySelectorAll('#themeCtl .chip').forEach(function (c) {
    c.classList.toggle('on', c.getAttribute('data-theme') === prefs.theme);
  });
  document.querySelectorAll('#sizeCtl .chip').forEach(function (c) {
    c.classList.toggle('on', c.getAttribute('data-size') === prefs.capsize);
  });
  document.querySelectorAll('#autoTrCtl .chip').forEach(function (c) {
    c.classList.toggle('on', (c.getAttribute('data-autotr') === 'on') === prefs.autoTranslate);
  });

  // 2.5단계에서 추가된 자막 설정들
  document.querySelectorAll('#capModeCtl .chip').forEach(function (c) {
    c.classList.toggle('on', c.getAttribute('data-capmode') === prefs.capMode);
  });
  document.querySelectorAll('#capContentCtl .chip').forEach(function (c) {
    c.classList.toggle('on', c.getAttribute('data-capcontent') === prefs.capContent);
  });
  document.querySelectorAll('#capLinesCtl .chip').forEach(function (c) {
    c.classList.toggle('on', Number(c.getAttribute('data-caplines')) === prefs.capLines);
  });
  document.querySelectorAll('#minHoldCtl .chip').forEach(function (c) {
    c.classList.toggle('on', Number(c.getAttribute('data-minhold')) === prefs.minHoldMs);
  });
}

/* 지금 설정에서 "듣는 중" 줄을 보여줘야 하는가 */
function showsInterim() {
  return prefs.capMode === 'flow' || prefs.capMode === 'phrase-live';
}

function applyPrefs() {
  document.body.classList.toggle('light', prefs.theme === 'light');
  document.body.setAttribute('data-capsize', prefs.capsize);
  document.body.setAttribute('data-capmode', prefs.capMode);
  document.body.setAttribute('data-capcontent', prefs.capContent);
  if (!showsInterim()) interimEl.textContent = '';
  trimCaptions();     // 줄 수를 바꾼 경우 즉시 반영
  paintChips();
}

/* ══════════════════════════════════════════════════════════
   11. 언어 드롭다운
   ══════════════════════════════════════════════════════════ */
function buildOptions() {
  var autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = '자동 감지 (채팅 전용)';
  sourceSel.appendChild(autoOpt);

  LANGS.forEach(function (lang) {
    var a = document.createElement('option');
    a.value = lang.code; a.textContent = lang.name;
    sourceSel.appendChild(a);

    var b = document.createElement('option');
    b.value = lang.code; b.textContent = lang.name;
    targetSel.appendChild(b);
  });
}

function swapLangs() {
  var s = sourceSel.value, t = targetSel.value;
  if (s === 'auto') {
    if (!lastDetected) {
      setStatus('자동 감지 상태입니다. 한 번 번역한 뒤에 바꾸거나, 원어를 직접 골라 주세요.', 'err');
      return;
    }
    sourceSel.value = t;
    targetSel.value = lastDetected;
  } else {
    sourceSel.value = t;
    targetSel.value = s;
  }
  onLangChanged();
  setStatus(langName(sourceSel.value) + ' → ' + langName(targetSel.value), 'ok');
}

function onLangChanged() {
  prefs.source = sourceSel.value;
  prefs.target = targetSel.value;
  savePrefs();

  // 듣는 중에 원어를 바꾸면, 인식기를 새 언어로 다시 켭니다.
  if (listening) {
    setStatus('원어가 바뀌어 음성 인식을 다시 시작합니다.', '');
    setStoppedByUser(true, '원어가 바뀌어 인식기를 다시 만드는 중');
    try { recognition.stop(); } catch (e) {}
    setTimeout(function () { startListening(); }, 400);
  }
}

/* ══════════════════════════════════════════════════════════
   12. 이벤트 연결
   ══════════════════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(function (t) {
  t.addEventListener('click', function () { switchMode(t.getAttribute('data-mode')); });
});

startBtn.addEventListener('click', startListening);
stopBtn.addEventListener('click', function () { stopListening(false); });
clearBtn.addEventListener('click', clearCaptions);

sendBtn.addEventListener('click', runChatTranslation);
swapBtn.addEventListener('click', swapLangs);
sourceSel.addEventListener('change', onLangChanged);
targetSel.addEventListener('change', onLangChanged);

inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', function (e) {
  // 한글 조합 중(isComposing)에는 무시해야 글자가 잘리지 않습니다.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    runChatTranslation();
  }
});

document.querySelectorAll('#themeCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.theme = c.getAttribute('data-theme'); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#sizeCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.capsize = c.getAttribute('data-size'); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#capModeCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.capMode = c.getAttribute('data-capmode'); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#capContentCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.capContent = c.getAttribute('data-capcontent'); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#capLinesCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.capLines = Number(c.getAttribute('data-caplines')); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#minHoldCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.minHoldMs = Number(c.getAttribute('data-minhold')); savePrefs(); applyPrefs();
  });
});
document.querySelectorAll('#autoTrCtl .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    prefs.autoTranslate = c.getAttribute('data-autotr') === 'on'; savePrefs(); applyPrefs();
  });
});

$('resetUsage').addEventListener('click', function () {
  usage = { date: todayStamp(), chars: 0 };
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) {}
  renderUsage();
  setStatus('사용량 숫자를 초기화했습니다.', 'ok');
});

$('resetPrefs').addEventListener('click', function () {
  try {
    localStorage.removeItem(PREF_KEY);
    localStorage.removeItem(USAGE_KEY);
  } catch (e) {}
  setStatus('저장된 설정을 지웠습니다. 새로고침하면 처음 상태가 됩니다.', 'ok', true);
});

// 탭을 닫거나 다른 페이지로 갈 때 마이크를 확실히 끕니다.
window.addEventListener('pagehide', function () {
  setStoppedByUser(true, '페이지를 떠남(pagehide)');
  try { if (recognition) recognition.abort(); } catch (e) {}
});

/* ══════════════════════════════════════════════════════════
   13. 시작
   ══════════════════════════════════════════════════════════ */
(function init() {
  buildOptions();
  loadPrefs();

  sourceSel.value = prefs.source || 'ko';
  targetSel.value = prefs.target || 'en';
  if (!sourceSel.value) sourceSel.value = 'ko';
  if (!targetSel.value) targetSel.value = 'en';

  applyPrefs();
  renderUsage();
  updateSpeakUI();
  autoGrow();
  switchMode('speak');

  checkBrowserSupport();
})();

/* ══════════════════════════════════════════════════════════
   14. (4단계) 브라우저 지원 검사 — 접속하자마자 한 번
   ══════════════════════════════════════════════════════════
   [용어] SpeechRecognition = 브라우저에 내장된 음성 인식 기능입니다.
   크롬과 엣지에만 있고 파이어폭스·사파리에는 없습니다.
   없는 브라우저에서 말하기 탭을 열면 아무 일도 안 일어나 고장처럼
   보이므로, 처음부터 안내를 띄우고 버튼을 막아 둡니다.

   ※ PiP 미지원 처리는 3단계에서 이미 해두었습니다 (버튼만 감춤).
     여기서는 건드리지 않습니다. */
function checkBrowserSupport() {
  if (SpeechRecognitionClass) return;   // 크롬·엣지 — 할 일 없음

  // 말하기 탭에 안내를 띄웁니다
  $('speakUnsupported').classList.remove('hidden');
  if (speakEmpty) { speakEmpty.remove(); speakEmpty = null; }

  // 눌러도 소용없는 버튼은 막습니다 (채팅 탭은 그대로 씁니다)
  startBtn.disabled = true;
  stopBtn.disabled = true;
  clearBtn.disabled = true;

  hintEl.textContent = '채팅 탭에서 글 번역은 정상 동작합니다.';
  console.warn('[지원 검사] 이 브라우저에는 SpeechRecognition 이 없습니다. 말하기 모드를 막았습니다.');
}
