/* config.js — 설정 상수 + 화면 요소  (가장 먼저 불립니다)
 * 앞부분은 동작을 좌우하는 숫자들입니다. 여기 값만 바꿔도 앱이 달라집니다.
 * var 로 둔 이유: F12 콘솔에서 INTERIM_CUT_CHARS = 50 처럼 바로
 * 바꿔가며 시험하기 위해서입니다.
 * 
 * 뒷부분은 화면 요소를 모아둔 곳($, captionsEl, startBtn …)입니다.
 * 원래 app.js 로 갈 자리였지만 여기로 옮겼습니다. translate.js 의
 * badgeEl = $('badge') 와 subtitle.js 의 pipBtn = $('pipBtn') 이
 * 파일을 불러오는 즉시 $ 를 필요로 하기 때문입니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════
   0. 설정값 — 여기 숫자만 바꿔도 동작이 달라집니다
   ══════════════════════════════════════════════════════════ */
var TRANSLATE_DEBOUNCE_MS = 500;   // 확정 문장이 멎고 이만큼 지나면 번역
var RESTART_DELAY_MS      = 200;   // 인식이 끊겼을 때 다시 켜기까지 간격
var NETWORK_RETRY_MS      = 3000;  // 네트워크 오류일 때 다시 켜기까지 간격
var WATCHDOG_MS           = 1000;  // 감시견이 확인하는 주기
                                   //   실제 감지 시각 = 한계 ~ 한계+주기.
                                   //   7000 + 1000 이므로 7~8초 사이에 잡힙니다.
var EVENT_SILENCE_LIMIT_MS = 7000; // ★ 이 시간 동안 어떤 이벤트도 없으면 죽은 것으로 판단
                                   //   var 로 둔 이유: F12 콘솔에서 값을 바로 바꿔가며
                                   //   시험할 수 있게 하려고. (예: EVENT_SILENCE_LIMIT_MS = 9000)
var REVIVE_ABORT_GAP_MS   = 300;   // abort() 하고 새 인식기로 다시 켜기까지 간격
var MAX_START_THROW_FAILS = 3;     // start() 가 예외를 던진 연속 횟수 — 이때만 중단
var MAX_NETWORK_FAILS     = 3;     // 연속 network 오류 허용 횟수
// ※ 침묵(no-speech)은 고장이 아니므로 어떤 횟수에도 세지 않고 무한히 재시작합니다.
var MIN_CHARS_TO_TRANSLATE = 2;    // 공백 뺀 글자가 이보다 적으면 번역 안 함
var DAILY_CHAR_BUDGET     = 15000; // 설정 화면 게이지 기준값

/* 4단계: LLM 맥락 번역
   번역을 부탁할 때 "직전에 확정된 원문" 몇 개를 함께 보냅니다.
   앞 내용을 알아야 대명사(그, 그것)와 말투가 이어집니다.
   늘리면 번역이 자연스러워지지만 보내는 글자 수가 늘어 할당량을 더 씁니다. */
var CONTEXT_SENTENCE_COUNT = 3;

/* 5단계: 중간 결과 끊기 ─────────────────────────────────────
   크롬은 말이 길게 이어지면 확정(isFinal)을 30초 넘게 미룹니다.
   그때까지 기다리면 번역이 시작조차 못 하므로, 중간 결과를
   우리가 알아서 끊어 번역에 넘깁니다.

   ※ var 로 둔 이유: F12 콘솔에서 값을 바로 바꿔가며 시험하려고요.
     예) INTERIM_CUT_CHARS = 50 */
var INTERIM_CUT_CHARS  = 70;    // 안 보낸 중간 결과가 이만큼 넘으면 끊습니다
var INTERIM_IDLE_MS    = 1500;  // 중간 결과가 이 시간 동안 안 바뀌면 끊습니다
var INTERIM_SAFE_TAIL  = 15;    // ★ 끝에서 이만큼은 남겨둡니다.
                                //   크롬이 중간 결과의 뒷부분을 계속 고쳐 쓰기 때문에,
                                //   너무 끝까지 잘라 보내면 틀린 채로 번역됩니다.
                                //   숫자를 키울수록 안전하지만 그만큼 늦게 나갑니다.

/* ══════════════════════════════════════════════════════════
   2. 화면 요소 모아두기
   ══════════════════════════════════════════════════════════ */
var $ = function (id) { return document.getElementById(id); };

var sourceSel = $('sourceLang'), targetSel = $('targetLang'), swapBtn = $('swapBtn');
var langbar   = $('langbar');
var captionsEl = $('captions'), interimEl = $('interim'), speakEmpty = $('speakEmpty');
var chatListEl = $('chatList'), chatEmpty = $('chatEmpty');
var inputEl = $('input'), sendBtn = $('sendBtn');
var startBtn = $('startBtn'), stopBtn = $('stopBtn'), clearBtn = $('clearBtn');
var statusEl = $('status'), hintEl = $('hint');

