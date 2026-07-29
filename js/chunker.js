/* chunker.js — 중간 결과 자체 끊기
 * 크롬이 확정(isFinal)을 한참 미루는 문제 때문에, 중간 결과를
 * 우리가 직접 끊어 번역에 넘깁니다.
 * 
 * speech.js 의 onresult 에서 불리고, 끊어낸 조각은
 * translate.js 의 handleFinalText() 로 넘깁니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════
   8.7 (5단계) 중간 결과를 우리가 끊어서 번역에 넘기기
   ══════════════════════════════════════════════════════════
   [왜 필요한가]
   크롬은 말이 계속 이어지면 확정(isFinal)을 한참 미룹니다. 실제로
   90단어짜리 한 덩어리를 확정하는 데 30초가 넘게 걸렸습니다.
   기존 코드는 확정된 것만 번역했으므로 체감 지연이 40초에 달했습니다.
   느린 건 LLM 이 아니라 크롬이었습니다.

   [무엇을 하는가]
   확정을 기다리지 않고, 중간 결과를 지켜보다가 아래 둘 중 하나면
   한 덩어리로 끊어서 곧바로 번역에 넘깁니다.
     ① 아직 안 보낸 부분이 INTERIM_CUT_CHARS 를 넘을 때
     ② 중간 결과가 INTERIM_IDLE_MS 동안 바뀌지 않을 때

   [조심한 것]
   크롬은 중간 결과의 뒷부분을 계속 고쳐 씁니다. 앞부분 단어가
   나중에 바뀌기도 합니다. 그래서 ① 로 끊을 때는 맨 끝
   INTERIM_SAFE_TAIL 글자를 건드리지 않고, 그 앞의 단어 경계에서만
   자릅니다. ② 는 아예 변화가 멎은 뒤라 그대로 다 보냅니다.

   ※ 2단계(감시견·재시작)와 3단계(PiP)에는 손대지 않았습니다.
     onresult 안에서도 markEvent 와 재시작 관련 줄은 그대로 두고,
     "결과를 어떻게 모아서 번역에 넘기느냐"만 바꿨습니다.
   ══════════════════════════════════════════════════════════ */

var interimFull    = '';    // 크롬이 지금 들려주고 있는 중간 결과 전체
var interimEmitted = 0;     // 그중 이미 번역에 넘긴 글자 수
var interimIdleTimer = null;
var interimStartedAt = 0;   // 이 덩어리가 시작된 시각 (지연 측정용)

function resetInterimCut() {
  clearTimeout(interimIdleTimer);
  interimIdleTimer = null;
  interimFull = '';
  interimEmitted = 0;
  interimStartedAt = 0;
}

/* 잘라낸 조각을 실제로 번역 줄에 넘깁니다.
   기존 handleFinalText() 를 그대로 씁니다. 그래야 0.5초 디바운스,
   중복 건너뛰기, 자막 줄 만들기가 예전과 똑같이 동작합니다. */
function emitInterimChunk(endIndex, why) {
  var chunk = interimFull.slice(interimEmitted, endIndex).trim();
  interimEmitted = endIndex;
  if (!chunk) return;

  var elapsed = interimStartedAt ? ((Date.now() - interimStartedAt) / 1000).toFixed(1) : '0.0';
  speechLog('✂ 중간 결과 끊음 [' + why + '] ' + chunk.length + '자'
    + '  (발화 시작 후 ' + elapsed + '초)  "' + chunk.slice(0, 40) + (chunk.length > 40 ? '…' : '') + '"');

  handleFinalText(chunk);
}

/* ① 길이로 끊기 ─────────────────────────────────────────── */
function cutInterimByLength() {
  // 한 번에 여러 덩어리가 밀려 들어올 수도 있어 while 로 돕니다
  for (var guard = 0; guard < 10; guard++) {
    var unsent = interimFull.slice(interimEmitted);
    if (unsent.length <= INTERIM_CUT_CHARS) return;

    // ★ 끝부분은 아직 고쳐 쓰일 수 있으니 손대지 않습니다
    var safeEnd = unsent.length - INTERIM_SAFE_TAIL;
    if (safeEnd <= 0) return;

    // 낱말을 쪼개지 않도록 안전 지점 앞의 마지막 띄어쓰기에서 자릅니다
    var cut = unsent.lastIndexOf(' ', safeEnd);

    if (cut <= 0) {
      /* 띄어쓰기가 없는 언어(중국어·일본어)는 위 방법이 통하지 않습니다.
         너무 길어지면 그냥 안전 지점에서 자릅니다. */
      if (unsent.length < INTERIM_CUT_CHARS * 2) return;
      cut = safeEnd;
    }

    emitInterimChunk(interimEmitted + cut, '길이 ' + INTERIM_CUT_CHARS + '자 초과');
  }
}

/* ② 멈춤으로 끊기 ───────────────────────────────────────── */
function cutInterimByIdle() {
  interimIdleTimer = null;
  if (interimEmitted >= interimFull.length) return;
  // 변화가 멎은 뒤라 끝까지 안전합니다. 남은 것을 전부 보냅니다.
  emitInterimChunk(interimFull.length, INTERIM_IDLE_MS + 'ms 동안 변화 없음');
}

/* 중간 결과가 새로 들어올 때마다 불립니다 (onresult 안에서) */
function handleInterimText(interim) {
  if (!interim) return;   // 빈 값은 무시합니다. 초기화는 확정 결과가 올 때 합니다.

  if (!interimStartedAt) interimStartedAt = Date.now();

  /* 크롬이 버퍼를 새로 시작하면 중간 결과가 갑자기 짧아집니다.
     그때는 세던 위치를 0 으로 되돌립니다. */
  if (interim.length < interimEmitted) {
    speechLog('중간 결과가 짧아졌습니다 (' + interimEmitted + '자 → ' + interim.length + '자) — 세던 위치를 초기화');
    interimEmitted = 0;
  }

  if (interim !== interimFull) {
    interimFull = interim;
    /* 글자가 바뀌었으니 "멈춤" 시계를 다시 겁니다.
       길어질 때만이 아니라 바뀌기만 해도 다시 거는 이유는,
       크롬이 고쳐 쓰는 도중에 잘라 보내지 않기 위해서입니다. */
    clearTimeout(interimIdleTimer);
    interimIdleTimer = setTimeout(cutInterimByIdle, INTERIM_IDLE_MS);
  }

  cutInterimByLength();
}

/* 앞부분을 이미 보냈을 때 남은 뒷부분만 잘라냅니다.
   크롬이 앞부분을 고쳐 쓰면 글자 수가 어긋나 낱말 중간이 잘릴 수 있어서,
   그런 경우엔 잘린 조각을 버리고 다음 낱말부터 시작합니다. */
function sliceRemainder(fullText, alreadyLen) {
  if (alreadyLen <= 0) return fullText.trim();
  if (alreadyLen >= fullText.length) return '';

  var rest = fullText.slice(alreadyLen);
  var charBefore = fullText.charAt(alreadyLen - 1);
  if (!/\s/.test(charBefore) && !/^\s/.test(rest)) {
    var sp = rest.search(/\s/);
    rest = (sp === -1) ? '' : rest.slice(sp + 1);
  }
  return rest.trim();
}

/* 크롬이 진짜 확정 결과를 보내왔을 때.
   ★ 이미 끊어서 번역한 앞부분은 빼고 남은 부분만 넘깁니다. */
function handleRecognizedFinal(text) {
  var rest = sliceRemainder(text, interimEmitted);
  var hadEmitted = interimEmitted;
  resetInterimCut();

  if (rest) {
    if (hadEmitted) speechLog('크롬 확정 도착 — 앞 ' + hadEmitted + '자는 이미 보냈으므로 남은 ' + rest.length + '자만 번역');
    handleFinalText(rest);
  } else {
    speechLog('크롬 확정 도착 — 이미 전부 번역한 내용이라 건너뜁니다');
  }
}

/* 정지 버튼을 눌렀을 때처럼, 남은 중간 결과를 마저 내보냅니다 */
function cutInterimRemaining(why) {
  clearTimeout(interimIdleTimer);
  interimIdleTimer = null;
  if (interimFull && interimEmitted < interimFull.length) {
    emitInterimChunk(interimFull.length, why);
  }
  resetInterimCut();
}

