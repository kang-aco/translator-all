/* translate.js — 번역 호출, 디바운스, 맥락, 오류 배지
 * /api/translate 중계기를 부르는 단 하나의 창구(callTranslateApi),
 * 말이 멎고 0.5초 뒤 한 번만 부르는 디바운스, 앞 문장을 맥락으로
 * 함께 보내는 처리, 실패를 화면에 알리는 배지가 있습니다.
 * 채팅 모드도 같은 창구를 씁니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════
   3.5 (4단계) 상단 배지 — 사용을 막지 않는 알림
   ══════════════════════════════════════════════════════════
   모달(팝업 창)은 쓰지 않습니다. 자막을 보는 중에 창이 뜨면
   읽는 흐름이 끊기고, 확인을 누르기 전까지 화면이 막히니까요.
   화면 맨 위에 한 줄로 잠깐 뜨는 배지로만 알립니다. */
var badgeEl = $('badge');
var badgeTimer = null;
var lastBadgeText = '';

function showBadge(msg, kind, holdMs) {
  // 같은 문구가 연달아 뜨면 시계만 다시 맞춥니다 (깜빡임 방지)
  if (msg !== lastBadgeText) {
    badgeEl.textContent = msg;
    lastBadgeText = msg;
  }
  badgeEl.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(function () {
    badgeEl.className = '';
    lastBadgeText = '';
  }, holdMs || 8000);
}

/* ══════════════════════════════════════════════════════════
   6. ★ 번역 API 호출 — 채팅과 자막이 함께 쓰는 단 하나의 창구 ★

   1단계에서 translate() 안에 들어 있던 fetch 부분을
   여기로 옮겨왔습니다. 브라우저는 여전히 키를 모르고,
   같은 사이트 주소인 /api/translate 만 부릅니다.

   성공하면 서버가 준 객체를 돌려주고,
   실패하면 예외를 던집니다. 부르는 쪽에서 try-catch 로 받습니다.
   ══════════════════════════════════════════════════════════ */
async function callTranslateApi(text, source, target, context) {
  /* context 는 4단계에서 추가된 "맥락 문장 목록"입니다.
     채팅 모드처럼 안 넘기는 곳도 있으므로 없으면 빈 배열로 둡니다. */
  var ctx = Array.isArray(context) ? context : [];

  var startedAt = Date.now();   // 응답까지 몇 초 걸리는지 재려고

  var res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text, source: source, target: target, context: ctx })
  });

  var data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw new Error('서버 응답을 읽지 못했습니다 (HTTP ' + res.status + ').');
  }

  if (!res.ok || data.error) {
    throw new Error(data.error || ('서버 오류 HTTP ' + res.status));
  }

  /* ★ 사용량 세기 (4단계에서 보완)
     맥락 문장까지 실제로 서버로 보냈으므로 그것도 함께 셉니다.
     본문만 세면 게이지가 실제 사용량보다 적게 나옵니다. */
  var ctxChars = 0;
  for (var i = 0; i < ctx.length; i++) ctxChars += ctx[i].length;
  addUsage(text.length + ctxChars);

  /* ★ 걸린 시간 콘솔에 남기기
     LLM 은 기존 번역기보다 느립니다. 얼마나 느린지 눈으로 보라고 찍습니다. */
  var took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('[번역 ' + took + '초] ' + data.engine
    + (data.model ? ' (' + data.model + ')' : '')
    + ' · 본문 ' + text.length + '자 + 맥락 ' + ctxChars + '자'
    + (data.segments ? ' → 문장 ' + data.segments.length + '개' : '')
    + (data.fallbackFrom ? '   ⚠ ' + data.fallbackFrom + ' 실패로 대체: ' + data.fallbackReason : ''));

  /* ★ 4단계: 콘솔에만 있던 소식을 화면에도 알립니다.
     맥락 번역(LLM)이 실패해 구글로 넘어가면 자막은 계속 나오지만
     번역 품질이 조용히 떨어집니다. 그걸 모르고 지나치지 않도록
     상단에 한 줄 배지로 띄웁니다. 사용을 막지는 않습니다. */
  if (data.fallbackFrom === 'gemini') {
    var why = String(data.fallbackReason || '');
    if (/429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(why)) {
      showBadge('번역 한도 초과 — 구글 번역으로 전환됨', 'warn');
    } else if (/\b404\b|not found/i.test(why)) {
      // 모델이 단종되면 여기로 옵니다. 예전에 이것 때문에 한참 헤맸습니다.
      showBadge('맥락 번역 모델을 찾을 수 없음 — 구글 번역으로 전환됨 (LLM_MODEL 확인)', 'warn', 15000);
    } else {
      showBadge('맥락 번역 실패 — 구글 번역으로 전환됨', 'warn');
    }
  }

  return data;
}

/* 오류 문구를 자막 한 줄에 들어갈 만큼 줄입니다.
   서버가 주는 원문에는 API 응답이 통째로 붙어 있어 그대로 쓰면
   자막 화면을 다 덮어버립니다. 자세한 내용은 콘솔에 남깁니다. */
function shortErrorText(err) {
  var msg = (err && err.message) ? String(err.message) : '';
  if (/429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) return '번역 한도 초과';
  if (/403/.test(msg)) return '번역 권한 오류';
  if (/\b404\b/.test(msg)) return '번역 모델 없음';
  if (/5\d\d/.test(msg)) return '번역 서버 오류';
  if (/Failed to fetch|NetworkError|네트워크/i.test(msg)) return '네트워크 끊김';
  if (!msg) return '알 수 없는 오류';
  return msg.length > 40 ? msg.slice(0, 40) + '…' : msg;
}

/* ══════════════════════════════════════════════════════════
   7. 채팅 모드
   ══════════════════════════════════════════════════════════ */
var lastDetected = null;   // ⇄ 버튼이 참고하는 최근 감지 언어
var chatBusy = false;

function addChatCard(originalText) {
  if (chatEmpty) { chatEmpty.remove(); chatEmpty = null; }
  var card = document.createElement('div');
  card.className = 'item pending';

  var orig = document.createElement('div');
  orig.className = 'orig';
  orig.textContent = originalText;

  var trans = document.createElement('div');
  trans.className = 'trans';
  trans.textContent = '번역 중…';

  var meta = document.createElement('div');
  meta.className = 'meta';

  card.appendChild(orig); card.appendChild(trans); card.appendChild(meta);
  chatListEl.insertBefore(card, chatListEl.firstChild);
  return { card: card, trans: trans, meta: meta };
}

async function runChatTranslation() {
  if (chatBusy) return;

  var text = inputEl.value.trim();
  if (!text) { setStatus('번역할 내용을 입력해 주세요.', 'err'); return; }

  var source = sourceSel.value, target = targetSel.value;
  if (source === target) { setStatus('원어와 목표어가 같습니다.', 'err'); return; }

  chatBusy = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '…';

  var refs = addChatCard(text);
  inputEl.value = '';
  autoGrow();

  try {
    var data = await callTranslateApi(text, source, target);   // ← 공용 창구 사용
    lastDetected = data.detectedSource || null;

    refs.card.className = 'item';
    refs.trans.textContent = data.translated;

    var bits = [nowLabel(), '엔진: ' + data.engine];
    if (data.detectedSource) bits.push('감지: ' + langName(data.detectedSource));
    bits.push('→ ' + langName(data.target));
    if (data.fallbackFrom) bits.push('(' + data.fallbackFrom + ' 실패로 대체)');
    refs.meta.textContent = bits.join(' · ');

    refs.card.addEventListener('click', function () {
      copyText(data.translated, refs.meta);
    });
  } catch (err) {
    refs.card.className = 'item error';
    refs.trans.textContent = '번역 실패: ' + (err && err.message ? err.message : '알 수 없는 오류');
    refs.meta.textContent = nowLabel() + ' · 입력은 그대로 두었으니 다시 시도해 보세요.';
    inputEl.value = text;
    autoGrow();
  } finally {
    chatBusy = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '번역';
    inputEl.focus();
  }
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
}

// 번역 호출 제어용
var finalBuffer      = '';    // 아직 번역을 안 보낸 확정 문장들
var activeLine       = null;  // 지금 글자가 쌓이는 중인 자막 줄
var translateTimer   = null;  // 디바운스 타이머
var lastTranslatedText = '';  // 직전에 번역한 문장 (같으면 건너뜀)

/* 4단계: 맥락으로 함께 보낼 "직전에 확정된 원문" 보관함.
   최대 CONTEXT_SENTENCE_COUNT 개만 들고 있다가 오래된 것부터 버립니다. */
var recentFinals = [];

function rememberContext(sentence) {
  var s = (sentence || '').trim();
  if (!s) return;
  recentFinals.push(s);
  while (recentFinals.length > CONTEXT_SENTENCE_COUNT) recentFinals.shift();
}

/* ── 확정된 문장이 들어왔을 때 ── */
function handleFinalText(text) {
  var clean = text.trim();
  if (!clean) return;

  if (!activeLine) activeLine = createCaptionLine();

  finalBuffer = finalBuffer ? (finalBuffer + ' ' + clean) : clean;
  activeLine.src.textContent = finalBuffer;
  scrollToBottom();

  // ★ 디바운스: 말이 멎고 0.5초가 지나야 한 번 번역합니다.
  //   말이 이어지면 타이머를 계속 취소하고 다시 잡으므로
  //   문장이 여러 조각으로 끊겨도 API 호출은 한 번입니다.
  clearTimeout(translateTimer);
  translateTimer = setTimeout(flushTranslation, TRANSLATE_DEBOUNCE_MS);
}

/* ── 모아둔 문장을 실제로 번역 ── */
async function flushTranslation() {
  clearTimeout(translateTimer);

  var text = finalBuffer.trim();
  var line = activeLine;

  // 다음 발화는 새 줄에 쌓입니다
  finalBuffer = '';
  activeLine = null;

  if (!line || !text) return;

  // 자동 번역을 꺼둔 경우 — 원문만 남깁니다
  if (!prefs.autoTranslate) {
    line.dst.remove();
    return;
  }

  // 공백 뺀 글자 수가 너무 적으면 건너뜁니다
  var compact = text.replace(/\s/g, '');
  if (compact.length < MIN_CHARS_TO_TRANSLATE) {
    line.dst.className = 'dst waiting';
    line.dst.textContent = '(너무 짧아 번역하지 않음)';
    return;
  }

  // 직전에 번역한 문장과 같으면 건너뜁니다
  if (text === lastTranslatedText) {
    line.dst.className = 'dst waiting';
    line.dst.textContent = '(직전과 같은 문장 — 번역 생략)';
    return;
  }

  var source = sourceSel.value;
  var target = targetSel.value;
  if (source === target) {
    line.dst.className = 'dst waiting';
    line.dst.textContent = '(원어와 목표어가 같아 번역하지 않음)';
    return;
  }

  lastTranslatedText = text;
  // ★ 자리는 이미 잡혀 있습니다. 점 세 개를 그대로 두어 화면이 튀지 않게 합니다.
  line.dst.className = 'dst pending';
  line.dst.textContent = '···';

  // 4단계: 직전 원문 몇 개를 맥락으로 함께 보냅니다
  var context = recentFinals.slice(-CONTEXT_SENTENCE_COUNT);

  try {
    var data = await callTranslateApi(text, source, target, context);   // ← 공용 창구 사용

    if (data.segments && data.segments.length) {
      // LLM 이 문장을 나눠서 돌려준 경우 — 자막 줄도 그만큼 나눕니다
      renderSegments(line, data.segments, data.engine);
    } else {
      // 기존 번역기(구글·DeepL) — 예전 그대로 한 줄
      fillCaptionLine(line, null, data.translated, data.engine);
      rememberContext(text);
    }
  } catch (err) {
    // ★ 번역이 실패해도 원문 자막(line.src)은 그대로 남습니다.
    //   할당량 초과(403)나 네트워크 오류가 나도 자막은 계속 나옵니다.
    /* 4단계: 자막 줄에는 짧게만 적고, 자세한 내용은 콘솔에 남깁니다.
       원문 자막(line.src)은 그대로 남으므로 무슨 말이었는지는 보입니다. */
    line.dst.className = 'dst failed';
    line.dst.textContent = shortErrorText(err);
    line.dst.title = (err && err.message) ? err.message : '';   // 마우스를 올리면 전문
    console.warn('[번역 실패]', err);
    // 번역은 못 했어도 이 말은 실제로 나왔습니다. 다음 번역이 흐름을 잃지 않게 맥락에는 남깁니다.
    rememberContext(text);
  }
  scrollToBottom();
}

