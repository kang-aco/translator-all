/* speech.js — 음성 인식, 자동 재시작, 감시견
 * ★ 손대기 가장 위험한 곳입니다.
 * 인식기가 이벤트 없이 조용히 죽는 문제를 잡느라 오래 걸린 부분이
 * 여기 있습니다. markEvent, lastEventAt, startWatchdog,
 * reviveRecognition, discardRecognition 이 서로 물려 있습니다.
 * 
 * buildRecognition() 의 onresult 안에서 chunker.js 의
 * handleInterimText() 와 handleRecognizedFinal() 을 부릅니다.
 * 둘 다 전역 함수라 파일이 나뉘어도 그대로 찾아갑니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════
   8. 말하기 모드 — 음성 인식
   ══════════════════════════════════════════════════════════ */

// 크롬 계열은 webkit 접두사가 붙은 이름을 씁니다.
var SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

var recognition   = null;
var listening     = false;   // 지금 인식이 돌고 있는가
var isStoppedByUser = true;  // ★ 정지 버튼으로 멈춘 것인가 (자동 재시작 판단 기준)
var startThrowFails = 0;     // start() 가 연속으로 예외를 던진 횟수 — 이때만 중단
var networkFails  = 0;       // 연속 network 오류 횟수
var restartCount  = 0;       // 지금까지 자동 재시작한 총 횟수 (기록용)
var lastErrorKind = null;    // 직전 onerror 의 종류
var restartTimer  = null;
var nextRestartDelay = RESTART_DELAY_MS;

/* ★ 마지막으로 인식기에서 이벤트가 온 시각.
     감시견은 listening 플래그가 아니라 이 시각을 보고 판단합니다.
     플래그는 거짓말을 할 수 있지만("살아있다"고 굳어버림),
     "12초 동안 아무 이벤트도 없었다"는 사실은 거짓말을 못 합니다. */
var lastEventAt = 0;

/* ── F12 콘솔에 남기는 흔적 ──────────────────────────────
   나중에 자막이 또 멈추면 F12 → Console 에서
   [음성인식] 로 시작하는 줄만 보면 됩니다. */
function stamp() {
  var d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':'
       + String(d.getMinutes()).padStart(2, '0') + ':'
       + String(d.getSeconds()).padStart(2, '0') + '.'
       + String(d.getMilliseconds()).padStart(3, '0');
}

function speechLog() {
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[음성인식 ' + stamp() + ']');
  console.log.apply(console, args);
}

/* ★ 인식기에서 온 모든 이벤트는 반드시 이 함수를 거칩니다.
     여기서 시각을 갱신하고 콘솔에 한 줄 남깁니다. */
function markEvent(name, extra) {
  var gap = lastEventAt ? ((Date.now() - lastEventAt) / 1000).toFixed(1) : '0.0';
  lastEventAt = Date.now();
  speechLog('▸ ' + name + (extra ? '  ' + extra : '') + '   (직전 이벤트로부터 ' + gap + '초)');
}

/* ── isStoppedByUser 는 반드시 이 함수로만 바꿉니다 ──────
   값이 바뀔 때마다 "누가 왜 바꿨는지"가 콘솔에 남습니다.
   의도치 않게 true 가 되는 경로를 추적하기 위한 장치입니다. */
function setStoppedByUser(value, reason) {
  if (isStoppedByUser !== value) {
    speechLog('isStoppedByUser: ' + isStoppedByUser + ' → ' + value + '   이유: ' + reason);
  }
  isStoppedByUser = value;
}

/* ── 콘솔에서 speechState() 를 치면 현재 상태를 볼 수 있습니다 ── */
window.speechState = function () {
  var idleSec = lastEventAt ? ((Date.now() - lastEventAt) / 1000).toFixed(1) : null;
  return {
    듣는중_플래그: listening,
    사용자가정지함: isStoppedByUser,
    마지막이벤트시각: lastEventAt ? new Date(lastEventAt).toLocaleTimeString('ko-KR') : '(아직 없음)',
    마지막이벤트이후초: idleSec,
    죽은것으로판단: idleSec !== null && Number(idleSec) * 1000 >= EVENT_SILENCE_LIMIT_MS,
    한계초: EVENT_SILENCE_LIMIT_MS / 1000,
    총재시작횟수: restartCount,
    start예외누적: startThrowFails + '/' + MAX_START_THROW_FAILS,
    네트워크오류누적: networkFails + '/' + MAX_NETWORK_FAILS,
    직전오류: lastErrorKind,
    다음재시작지연ms: nextRestartDelay
  };
};

/* ── 인식기 만들기 ── */
function buildRecognition() {
  var rec = new SpeechRecognitionClass();
  rec.continuous     = true;   // 한 문장 끝나도 계속 듣기
  rec.interimResults = true;   // 확정 전 중간 결과도 받기
  rec.maxAlternatives = 1;     // 후보를 하나만 받기
  rec.lang = speechTag(sourceSel.value) || 'ko-KR';

  /* ★ 인식기가 살아 있다는 증거가 되는 이벤트 전부에 표시를 답니다.
       하나라도 오면 lastEventAt 이 갱신되고, 감시견은 그걸 보고 판단합니다. */
  rec.onaudiostart  = function () { markEvent('onaudiostart  (마이크 열림)'); };
  rec.onsoundstart  = function () { markEvent('onsoundstart  (소리 감지)'); };
  rec.onspeechstart = function () { markEvent('onspeechstart (말소리 시작)'); };
  rec.onspeechend   = function () { markEvent('onspeechend   (말소리 끝)'); };
  rec.onsoundend    = function () { markEvent('onsoundend    (소리 끊김)'); };
  rec.onaudioend    = function () { markEvent('onaudioend    (마이크 닫힘)'); };
  rec.onnomatch     = function () { markEvent('onnomatch     (알아듣지 못함)'); };

  rec.onstart = function () {
    markEvent('onstart', '(lang=' + rec.lang + ')');
    listening = true;
    startThrowFails = 0;   // start() 가 통했으니 예외 누적을 되돌립니다
    lastErrorKind = null;
    updateSpeakUI();
  };

  rec.onresult = function (event) {
    markEvent('onresult');
    // 인식 결과가 실제로 왔다 = 네트워크가 살아 있다는 뜻
    networkFails = 0;

    var interim = '';
    // resultIndex 부터 보는 이유: 이미 처리한 앞부분을 다시 읽지 않기 위해서입니다.
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var r = event.results[i];
      if (r.isFinal) {
        // 5단계: 이미 끊어 보낸 앞부분을 빼고 남은 것만 번역합니다
        handleRecognizedFinal(r[0].transcript);
      } else {
        interim += r[0].transcript;
      }
    }
    // 5단계: 확정을 기다리지 않고 중간 결과를 우리가 끊습니다
    handleInterimText(interim);

    // 표시 방식에 따라 "듣는 중" 줄을 채울지 결정합니다.
    // (구절 모드에서는 중간 결과를 화면에 띄우지 않습니다)
    interimEl.textContent = showsInterim() ? interim : '';
    if (interim) scrollToBottom();
  };

  /* ★ onerror 는 "무슨 일이 있었는지 적어두기"만 합니다.
       여기서는 절대 start() 를 부르지 않습니다.
       no-speech 처럼 onerror 와 onend 가 둘 다 오는 경우
       양쪽에서 start() 를 부르면 두 번째가 InvalidStateError 로 죽습니다. */
  rec.onerror = function (event) {
    var kind = event.error;
    markEvent('onerror', '종류=' + kind);
    lastErrorKind = kind;

    if (kind === 'no-speech') {
      // ★ 침묵은 고장이 아닙니다.
      //   어떤 실패 횟수에도 세지 않고 무한히 재시작합니다.
      //   게다가 서비스가 "소리가 없었다"고 답을 줬다는 것은
      //   네트워크가 살아 있다는 증거이므로 네트워크 누적도 되돌립니다.
      networkFails = 0;
      return;
    }

    if (kind === 'aborted') {
      return;  // 우리가 stop()/abort() 를 불렀을 때 — 무시
    }

    if (kind === 'not-allowed' || kind === 'service-not-allowed') {
      // 먼저 확실히 멈춘 뒤에 모드를 바꾸고,
      // 안내 문구는 맨 마지막에 띄웁니다.
      // (순서가 바뀌면 switchMode 가 이 안내를 덮어써 버립니다)
      setStoppedByUser(true, '마이크 권한 거부(not-allowed)');
      listening = false;
      clearTimeout(restartTimer);
      try { recognition.abort(); } catch (e) {}
      updateSpeakUI();
      switchMode('chat');
      setStatus('마이크 사용이 거부되었습니다. 주소창 왼쪽 자물쇠(또는 카메라) 아이콘에서 마이크를 허용한 뒤 말하기 탭에서 다시 시작해 주세요.', 'err', true);
      return;
    }

    if (kind === 'network') {
      networkFails++;
      speechLog('네트워크 오류 누적 ' + networkFails + '/' + MAX_NETWORK_FAILS);
      if (networkFails >= MAX_NETWORK_FAILS) {
        haltListening(
          '네트워크 문제로 음성 인식을 ' + MAX_NETWORK_FAILS + '번 이어가지 못했습니다. 연결을 확인한 뒤 시작을 다시 눌러 주세요.',
          'network 오류 ' + MAX_NETWORK_FAILS + '회 연속');
      } else {
        nextRestartDelay = NETWORK_RETRY_MS;
        setStatus('네트워크가 불안정합니다. 3초 뒤 다시 시도합니다… (' + networkFails + '/' + MAX_NETWORK_FAILS + ')', 'err');
      }
      return;
    }

    setStatus('음성 인식 오류: ' + kind, 'err');
  };

  /* ★ 재시작은 오직 여기 한 곳에서만 일어납니다. */
  rec.onend = function () {
    markEvent('onend', '(직전 오류: ' + (lastErrorKind || '없음') + ', 사용자정지: ' + isStoppedByUser + ')');
    listening = false;
    updateSpeakUI();

    // 크롬은 몇 초간 소리가 없으면 continuous 여도 스스로 끝냅니다.
    // 사용자가 정지를 누른 게 아니라면 다시 켭니다.
    if (isStoppedByUser) {
      flushTranslation();   // 남은 문장을 마저 번역
      return;
    }

    var delay = nextRestartDelay;
    nextRestartDelay = RESTART_DELAY_MS;
    lastErrorKind = null;
    scheduleRestart(delay);
  };

  return rec;
}

function scheduleRestart(delay) {
  if (isStoppedByUser) return;
  if (reviving) { speechLog('재시작 예약 생략 (되살리기 진행 중)'); return; }
  clearTimeout(restartTimer);
  speechLog('재시작 예약 — ' + delay + 'ms 뒤');

  restartTimer = setTimeout(function () {
    if (isStoppedByUser) {
      speechLog('재시작 취소 (사용자가 정지함)');
      return;
    }
    if (reviving) {
      speechLog('재시작 취소 (되살리기가 대신 처리 중)');
      return;
    }
    // 인식기가 없으면(되살리기 직후 등) 통째로 다시 만듭니다.
    if (!recognition) {
      speechLog('인식기가 없어 되살리기로 넘깁니다');
      reviveRecognition();
      return;
    }
    // ★ 이미 돌고 있으면 부르지 않습니다. start() 이중 호출 방지장치입니다.
    //   혹시 이 판단이 틀렸더라도 감시견이 12초 안에 잡아냅니다.
    if (listening) {
      speechLog('재시작 건너뜀 (이미 듣는 중)');
      return;
    }

    restartCount++;
    speechLog('재시작 시도 #' + restartCount);

    try {
      recognition.start();
    } catch (e) {
      // 여기 걸리는 건 진짜 고장입니다 (보통 InvalidStateError).
      startThrowFails++;
      console.error('[음성인식] start() 예외 (' + startThrowFails + '/' + MAX_START_THROW_FAILS + ')', e);
      if (startThrowFails >= MAX_START_THROW_FAILS) {
        haltListening('음성 인식을 다시 시작하지 못했습니다. 시작 버튼을 눌러 주세요.',
                      'start() 예외 ' + startThrowFails + '회 연속');
      } else {
        scheduleRestart(RESTART_DELAY_MS);
      }
    }
  }, delay);
}

/* ── 감시견 ────────────────────────────────────────────────
   ★ 인식기가 onend 조차 없이 조용히 죽는 경우가 있습니다.
     그러면 재시작 로직은 실행될 기회조차 없고,
     listening 플래그는 true 로 굳어 "정상"인 척합니다.

     그래서 플래그를 믿지 않고 "마지막 이벤트 시각"만 봅니다.
     12초 동안 어떤 이벤트도 없었으면 죽은 것으로 확정합니다. */
var watchdogTimer = null;
var reviveTimer = null;
var reviving = false;

/* 되살리기 예약을 확실히 취소합니다.
   (되살리는 300ms 사이에 사용자가 시작을 누르면 인식기가 둘 생길 수 있습니다) */
function cancelRevive() {
  clearTimeout(reviveTimer);
  reviveTimer = null;
  reviving = false;
}

function startWatchdog() {
  clearInterval(watchdogTimer);
  lastEventAt = Date.now();
  watchdogTimer = setInterval(function () {
    if (isStoppedByUser) return;   // 사용자가 멈춘 거면 건드리지 않습니다
    if (reviving) return;          // 이미 되살리는 중

    var idle = Date.now() - lastEventAt;
    if (idle < EVENT_SILENCE_LIMIT_MS) return;

    speechLog('⚠ 감시견: ' + (idle / 1000).toFixed(1) + '초 동안 이벤트가 하나도 없었습니다. '
      + '(듣는중 플래그=' + listening + ') → 강제로 되살립니다');
    reviveRecognition();
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

/* ── 강제 되살리기 ─────────────────────────────────────────
   이미 죽은 객체에 start() 만 부르면 안 먹힐 수 있습니다.
   ① 죽은 객체의 이벤트 연결을 끊고  ② abort() 로 확실히 버린 뒤
   ③ 300ms 쉬고  ④ 인식기를 새로 만들어서 시작합니다. */
/* 인식기를 확실히 버립니다.
   죽은 객체가 뒤늦게 이벤트를 뱉어도 새 인식기를 방해하지 못하게 연결부터 끊습니다.
   ★ listening 플래그도 여기서 반드시 내립니다.
     죽은 인식기는 stop() 을 불러도 onend 를 안 보내므로,
     이걸 안 내리면 플래그가 true 로 굳어 다음 시작이 막힙니다. */
function discardRecognition(why) {
  var dead = recognition;
  recognition = null;
  listening = false;
  if (!dead) return;

  dead.onstart = dead.onaudiostart = dead.onsoundstart = dead.onspeechstart =
  dead.onspeechend = dead.onsoundend = dead.onaudioend = dead.onnomatch =
  dead.onresult = dead.onend = dead.onerror = null;
  try {
    dead.abort();
    speechLog('인식기 버림 — ' + why);
  } catch (e) {
    console.error('[음성인식] abort() 예외 (무시하고 진행)', e);
  }
}

function reviveRecognition() {
  if (reviving) { speechLog('되살리기가 이미 진행 중 — 건너뜁니다'); return; }
  reviving = true;
  clearTimeout(restartTimer);

  discardRecognition('감시견이 죽었다고 판단');
  updateSpeakUI();

  clearTimeout(reviveTimer);
  reviveTimer = setTimeout(function () {
    reviving = false;
    reviveTimer = null;
    if (isStoppedByUser) { speechLog('되살리기 취소 (사용자가 정지함)'); return; }

    restartCount++;
    speechLog('되살리기 — 새 인식기로 시작 #' + restartCount);

    recognition = buildRecognition();
    lastEventAt = Date.now();   // 새 출발이므로 시계를 다시 맞춥니다
    try {
      recognition.start();
    } catch (e) {
      startThrowFails++;
      console.error('[음성인식] 되살리기 start() 예외 ('
        + startThrowFails + '/' + MAX_START_THROW_FAILS + ')', e);
      if (startThrowFails >= MAX_START_THROW_FAILS) {
        haltListening('음성 인식을 되살리지 못했습니다. 시작 버튼을 눌러 주세요.',
                      '되살리기 start() 예외 ' + startThrowFails + '회');
      } else {
        reviveTimer = setTimeout(reviveRecognition, RESTART_DELAY_MS);
      }
    }
  }, REVIVE_ABORT_GAP_MS);
}

function haltListening(message, reason) {
  stopWatchdog();
  cancelRevive();
  setStoppedByUser(true, reason || '중단 요청');
  listening = false;
  clearTimeout(restartTimer);
  try { if (recognition) recognition.abort(); } catch (e) {}
  flushTranslation();
  updateSpeakUI();
  if (message) setStatus(message, 'err', true);
}

/* ── 시작 / 정지 / 지우기 ── */
function startListening() {
  if (!SpeechRecognitionClass) {
    setStatus('이 브라우저는 음성 인식을 지원하지 않습니다. 크롬이나 엣지에서 열어 주세요.', 'err', true);
    return;
  }
  if (sourceSel.value === 'auto') {
    setStatus('말하기 모드에서는 원어를 직접 골라야 합니다. 자동 감지는 쓸 수 없습니다.', 'err', true);
    return;
  }
  // ★ 예전 인식기가 남아 있으면(플래그가 굳었든 아니든) 먼저 확실히 버립니다.
  //   여기서 "이미 듣는 중이면 그냥 return" 하면,
  //   죽은 인식기 때문에 플래그가 true 로 굳었을 때 시작 버튼이 영영 안 먹습니다.
  if (recognition || listening) {
    discardRecognition('시작 버튼을 눌러 새로 시작');
  }

  clearTimeout(restartTimer);   // 남아 있을지 모를 예약을 먼저 지웁니다
  startThrowFails = 0;
  networkFails = 0;
  restartCount = 0;
  lastErrorKind = null;
  cancelRevive();
  lastEventAt = Date.now();
  nextRestartDelay = RESTART_DELAY_MS;
  setStoppedByUser(false, '사용자가 시작 버튼을 누름');   // ★ 이제부터 끊기면 자동 재시작

  recognition = buildRecognition();
  speechLog('시작 요청 (lang=' + recognition.lang + ')');
  startWatchdog();
  try {
    recognition.start();
    setStatus('듣고 있습니다. 말해 보세요.', 'ok');
  } catch (e) {
    console.error('[음성인식] 첫 start() 예외', e);
    setStoppedByUser(true, '첫 start() 가 예외를 던짐');
    setStatus('음성 인식을 시작하지 못했습니다: ' + e.message, 'err', true);
    updateSpeakUI();
  }
}

function stopListening(quiet) {
  // ★ 이 값 때문에 onend 가 재시작하지 않습니다
  setStoppedByUser(true, quiet ? '모드 전환/언어 변경으로 내부 정지' : '사용자가 정지 버튼을 누름');
  stopWatchdog();
  cancelRevive();
  clearTimeout(restartTimer);
  try { if (recognition) recognition.stop(); } catch (e) {}
  // 죽은 인식기는 onend 를 안 보내므로 플래그를 여기서 직접 내립니다.
  listening = false;
  interimEl.textContent = '';
  cutInterimRemaining('정지');  // 5단계: 아직 안 보낸 중간 결과를 마저 내보냅니다
  flushTranslation();          // 남은 문장 마저 번역
  updateSpeakUI();
  if (!quiet) setStatus('자막을 멈췄습니다.', '');
}

function updateSpeakUI() {
  // 4단계: 음성 인식이 없는 브라우저에서는 시작 버튼이 다시 켜지지 않게 합니다
  startBtn.disabled = listening || !SpeechRecognitionClass;
  stopBtn.disabled  = !listening;
  startBtn.innerHTML = listening
    ? '<span class="dot blink"></span>듣는 중'
    : '시작';
}

