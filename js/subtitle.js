/* subtitle.js — 자막 그리기와 PiP 창
 * ★ PiP 부분이 깨지기 쉽습니다.
 * 자막 요소(#captions, #interim)를 별도 창으로 통째로 옮기고,
 * MutationObserver 로 지켜보다가 인라인 스타일을 다시 바릅니다.
 * 창을 닫으면 pagehide 에서 본 페이지로 되돌립니다.
 *
 * ※ index.html 에 있던 코드를 위치만 옮긴 것입니다.
 *   변수명·함수명·로직·순서를 하나도 바꾸지 않았습니다.
 *   ES 모듈(import/export)을 쓰지 않으므로 모든 var 와 function 이 전역에
 *   그대로 남습니다. F12 콘솔에서 예전처럼 값을 바꿀 수 있습니다.
 */
/* ───────────────── 여기부터 원본 그대로 ───────────────── */
'use strict';

/* ── 자막 한 줄 만들기 ── */
function createCaptionLine() {
  if (speakEmpty) { speakEmpty.remove(); speakEmpty = null; }

  var wrap = document.createElement('div');
  wrap.className = 'caption';
  wrap.dataset.born = String(Date.now());   // 언제 생겼는지 (최소 표시 시간 계산용)

  var src = document.createElement('div');
  src.className = 'src';

  var dst = document.createElement('div');
  // ★ 번역이 도착하기 전까지 자리를 지키는 흐린 점 세 개
  dst.className = 'dst pending';
  dst.textContent = prefs.autoTranslate ? '···' : '';

  var when = document.createElement('div');
  when.className = 'when';
  when.textContent = nowLabel();

  wrap.appendChild(src); wrap.appendChild(dst); wrap.appendChild(when);
  captionsEl.appendChild(wrap);
  trimCaptions();
  scrollToBottom();

  return { wrap: wrap, src: src, dst: dst, when: when };
}

/* ── 줄 수 유지 + 최소 표시 시간 ──────────────────────────
   정해진 개수를 넘으면 맨 위(가장 오래된) 자막을 지웁니다.
   다만 그 자막이 아직 최소 표시 시간을 못 채웠으면 지우지 않고,
   시간이 될 때 다시 시도합니다. 그동안은 잠깐 한 줄 더 보입니다. */
var trimTimer = null;

function trimCaptions() {
  clearTimeout(trimTimer);

  var max = prefs.capLines;
  while (captionsEl.children.length > max) {
    var oldest = captionsEl.children[0];
    var age = Date.now() - Number(oldest.dataset.born || 0);

    if (age < prefs.minHoldMs) {
      // 아직 이릅니다. 남은 시간만큼 기다렸다가 다시 확인합니다.
      trimTimer = setTimeout(trimCaptions, prefs.minHoldMs - age);
      return;
    }
    oldest.remove();
  }
}

function scrollToBottom() {
  var main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
}

/* ── 자막 한 줄에 결과를 채워 넣기 (4단계) ──────────────────
   원래 flushTranslation 안에 흩어져 있던 처리를 함수로 묶은 것입니다.
   내용만 채울 뿐, 줄을 만들거나 지우는 일은 하지 않습니다. */
function fillCaptionLine(line, srcText, dstText, engine) {
  if (srcText) line.src.textContent = srcText;   // 구두점이 복원된 원문
  line.dst.className = 'dst';
  line.dst.textContent = dstText;
  line.when.textContent = nowLabel() + ' · ' + engine;
  line.dst.addEventListener('click', function () {
    copyText(dstText, line.when);
  });
}

/* ── 문장이 여러 개 온 경우 자막 줄을 나눠서 그리기 (4단계) ──
   LLM 은 뭉쳐 있던 말을 여러 문장으로 나눠서 돌려줍니다.
   ★ 첫 문장은 이미 만들어져 있는 줄에 넣고,
     나머지는 기존 createCaptionLine() 을 그대로 다시 부릅니다.
     새로 만드는 방식을 쓰지 않았기 때문에
     2.5단계의 줄 수 유지·최소 표시 시간과 3단계의 PiP 창 표시가
     아무것도 고치지 않고 그대로 동작합니다. */
function renderSegments(firstLine, segments, engine) {
  for (var i = 0; i < segments.length; i++) {
    var line = (i === 0) ? firstLine : createCaptionLine();
    fillCaptionLine(line, segments[i].source, segments[i].translated, engine);
    rememberContext(segments[i].source || segments[i].translated);
  }
  scrollToBottom();
}

/* ── "듣는 중" 회색 줄 채우기 — 뒤쪽만 보이게 ──────────────
   인식 중인 문장 전체를 다 보여주면 창의 절반을 차지해 자막을 가립니다.
   INTERIM_MAX_LINES 줄을 넘으면 앞부분을 잘라내고 최신 부분만 남깁니다.

   [왜 글자 수가 아니라 높이로 재는가]
   한 줄에 몇 글자가 들어가는지는 글자 크기와 창 너비에 따라 달라집니다.
   설정에서 "아주 크게"를 고르거나 PiP 창 폭을 줄이면 확 바뀝니다.
   그래서 글자 수로 자르지 않고, 실제로 그려본 높이를 재서 자릅니다.

   ※ 기존 자막 로직(createCaptionLine, trimCaptions)은 건드리지 않습니다.
     이 함수는 #interim 한 줄에만 씁니다. */
function setInterimText(text) {
  if (!text) { interimEl.textContent = ''; return; }

  interimEl.textContent = text;
  if (!INTERIM_MAX_LINES || INTERIM_MAX_LINES < 1) return;   // 0 이면 자르지 않음

  /* 이 요소가 본 페이지에 있든 PiP 창에 있든 맞는 창에서 계산값을 읽습니다.
     PiP 창은 다른 문서라서 window.getComputedStyle 로는 어긋날 수 있습니다. */
  var view = interimEl.ownerDocument.defaultView || window;
  var cs = view.getComputedStyle(interimEl);
  var lh = parseFloat(cs.lineHeight);
  if (!lh) lh = parseFloat(cs.fontSize) * 1.55;   // lineHeight 가 'normal' 일 때
  var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  var maxH = lh * INTERIM_MAX_LINES + pad + 1;    // 1px 은 반올림 여유

  if (interimEl.scrollHeight <= maxH) return;     // 안 넘치면 그대로 둡니다

  /* 앞에서부터 몇 낱말을 버려야 들어가는지 이진 탐색으로 찾습니다.
     한 글자씩 줄여가며 재면 너무 느려서, 절반씩 좁혀 7번 안에 끝냅니다. */
  var words = text.split(' ');
  var lo = 0, hi = words.length - 1, best = words.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    interimEl.textContent = '… ' + words.slice(mid).join(' ');
    if (interimEl.scrollHeight <= maxH) { best = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  interimEl.textContent = (best > 0 ? '… ' : '') + words.slice(best).join(' ');
}

function clearCaptions() {
  captionsEl.innerHTML = '';
  interimEl.textContent = '';
  clearTimeout(translateTimer);
  clearTimeout(trimTimer);
  finalBuffer = '';
  activeLine = null;
  lastTranslatedText = '';
  recentFinals = [];   // 4단계: 화면을 지웠으면 맥락도 함께 비웁니다
  resetInterimCut();   // 5단계: 끊어 보내던 위치도 초기화
  if (!speakEmpty) {
    speakEmpty = document.createElement('p');
    speakEmpty.className = 'empty';
    speakEmpty.id = 'speakEmpty';
    speakEmpty.innerHTML = '원어를 고르고 <b>시작</b>을 누른 뒤 말해 보세요.';
    // 3단계: 자막이 PiP 창에 나가 있으면 captionsEl 이 여기 없습니다.
    //        그때는 그냥 뒤에 붙입니다. 창을 닫으면 자막이 그 뒤로 돌아오므로 순서가 맞습니다.
    var home = $('view-speak');
    if (captionsEl.parentNode === home) home.insertBefore(speakEmpty, captionsEl);
    else home.appendChild(speakEmpty);
  }
  setStatus('자막을 지웠습니다.', '');
}

/* ══════════════════════════════════════════════════════════
   8.5 (3단계) 자막을 별도 창으로 — Document Picture-in-Picture
   ══════════════════════════════════════════════════════════
   [용어]
   Document Picture-in-Picture = 아무 HTML이나 담을 수 있는 작은 창을
   화면 맨 위에 띄우는 기능입니다. 유튜브 미니 플레이어의 사촌인데,
   영상만이 아니라 우리가 만든 요소를 그대로 담을 수 있습니다.

   [방식]
   자막 묶음(#captions)과 듣는 중 줄(#interim)을 "복사"하지 않고
   통째로 옮깁니다. 그래서 2단계·2.5단계 로직(createCaptionLine,
   trimCaptions 등)은 한 글자도 고치지 않아도 그대로 동작합니다.
   요소가 어느 창에 들어 있는지는 그 로직들이 신경 쓰지 않으니까요.

   [주의]
   PiP 창은 새 문서라서 본 페이지의 <style> 이 상속되지 않습니다.
   그래서 여기서는 element.style.~ 로 인라인 스타일을 직접 발라줍니다.
   ══════════════════════════════════════════════════════════ */

var PIP_SUPPORTED = ('documentPictureInPicture' in window);

/* 배경 어둡기. 알파값(마지막 숫자)만 바꾸면 됩니다.
   ※ 창 자체를 반투명하게 만드는 건 웹 코드로 불가능합니다.
     PiP 창은 불투명한 창이라 알파를 낮추면 뒤 영상이 비치는 게 아니라
     흰 바탕과 섞여 흐려집니다. "얼마나 진한 검정인가"를 정하는 값입니다. */
var PIP_BG_DARK  = 'rgba(8, 10, 14, 0.94)';
var PIP_BG_LIGHT = 'rgba(255, 255, 255, 0.94)';

/* 글자 크기표 — [원문, 번역] (본 페이지 CSS 의 data-capsize 규칙과 같은 값)
   ★ 번역문이 원문보다 큽니다. 번역이 주인공이기 때문입니다.
     index.html 의 body[data-capsize=...] 규칙과 짝이 맞아야 하므로
     한쪽만 고치지 마세요. */
var PIP_SIZE_PX = { s: [14, 15], m: [16, 19], l: [19, 24], xl: [24, 31] };

var pipWin        = null;   // 열려 있는 PiP 창 (없으면 null)
var pipBody       = null;   // 자막이 들어가는 칸
var pipLangEl     = null;   // "EN → KO" 표시
var pipStopBtn    = null;
var pipCapObserver = null;  // 자막이 바뀌는지 지켜보는 감시자
var pipPrefObserver = null; // 설정이 바뀌는지 지켜보는 감시자
var pipTimer      = null;   // PiP 창 안에서 도는 타이머
var pipBtn        = $('pipBtn');

/* ── 지금 테마의 색을 그대로 읽어옵니다 ──────────────────
   CSS 변수(--accent 같은 것)를 계산된 값으로 꺼내오므로
   어둡게/밝게를 바꾸면 자동으로 따라옵니다. */
function pipColors() {
  var cs = getComputedStyle(document.body);
  function v(n) { return cs.getPropertyValue(n).trim(); }
  return {
    text:    v('--text'),
    muted:   v('--muted'),
    final:   v('--final'),
    interim: v('--interim'),
    accent:  v('--accent'),
    fail:    v('--fail'),
    line:    v('--line')
  };
}

/* ── 자막 한 줄에 인라인 스타일 바르기 ──────────────────────
   ★ PiP 창은 본 페이지의 <style> 을 물려받지 않습니다. 그래서 여기서
     자바스크립트로 직접 발라야 합니다. index.html 의 .caption 규칙과
     같은 모양이 되도록 짝을 맞춰 두었습니다. 한쪽만 고치면 어긋납니다.

   읽기 편한 것이 먼저라서, 번역문은 크고 진하게 / 원문은 작고 흐리게 합니다. */
function pipStyleCaption(wrap, c, size) {
  wrap.style.cssText = 'padding:7px 0;';

  var src = wrap.querySelector('.src');
  var dst = wrap.querySelector('.dst');
  var when = wrap.querySelector('.when');

  if (src) {                                   // 원문 — 보조
    src.style.cssText =
      'font-weight:400;word-break:break-word;line-height:1.5;'
      + 'color:' + c.muted + ';font-size:' + size[0] + 'px;'
      + 'display:' + (prefs.capContent === 'translation' ? 'none' : 'block') + ';';
  }

  if (dst) {                                   // 번역문 — 주인공
    // 상태(class)에 따라 색이 달라집니다 — 본 페이지 CSS 와 같은 규칙입니다.
    var cls = dst.className;
    var color = c.final, weight = '600', extra = '';
    if (cls.indexOf('pending') >= 0)      { color = c.interim; weight = '400'; extra = 'letter-spacing:.18em;'; }
    else if (cls.indexOf('waiting') >= 0) { color = c.muted;   weight = '400'; extra = 'font-style:italic;'; }
    else if (cls.indexOf('failed') >= 0)  { color = c.fail;    weight = '500'; }

    dst.style.cssText =
      'margin-top:6px;word-break:break-word;line-height:1.5;min-height:1.5em;'
      + 'color:' + color + ';font-size:' + size[1] + 'px;font-weight:' + weight + ';' + extra
      + 'display:' + (prefs.capContent === 'source' ? 'none' : 'block') + ';';
  }

  // ★ 시각·엔진 줄은 PiP 창에서 항상 감춥니다.
  //   영상 위에 얹는 자막이라 방해만 되기 때문입니다. (본 페이지에는 그대로 남습니다)
  if (when) when.style.cssText = 'display:none;';
}

/* ── 창 전체 다시 칠하기 ──────────────────────────────────
   자막이 새로 생기거나 번역이 도착하거나 설정이 바뀔 때마다 불립니다.
   자막은 많아야 4줄이라 매번 전부 칠해도 부담이 없습니다. */
function pipRestyle() {
  if (!pipWin) return;

  var c = pipColors();
  var size = PIP_SIZE_PX[prefs.capsize] || PIP_SIZE_PX.m;
  var dark = (prefs.theme !== 'light');

  pipWin.document.body.style.background = dark ? PIP_BG_DARK : PIP_BG_LIGHT;
  pipWin.document.body.style.color = c.text;
  if (pipLangEl) pipLangEl.style.color = c.muted;

  captionsEl.style.cssText = 'flex:0 0 auto;';
  var kids = captionsEl.children;
  for (var i = 0; i < kids.length; i++) pipStyleCaption(kids[i], c, size);

  // 듣는 중 줄 — 표시 방식에 따라 크기와 모양이 달라집니다
  var show = showsInterim() && interimEl.textContent.trim() !== '';
  if (!show) {
    interimEl.style.cssText = 'display:none;';
  } else if (prefs.capMode === 'phrase-live') {
    interimEl.style.cssText =
      'display:block;word-break:break-word;flex:0 0 auto;line-height:1.5;'
      + 'color:' + c.interim + ';font-size:13.5px;'
      + 'margin-top:8px;padding-top:10px;border-top:1px solid ' + c.line + ';';
  } else {
    interimEl.style.cssText =
      'display:block;word-break:break-word;flex:0 0 auto;padding:8px 0;line-height:1.5;'
      + 'color:' + c.interim + ';font-size:' + size[0] + 'px;';
  }
}

/* ── "EN → KO" 표시 ── */
function pipUpdateLang() {
  if (!pipLangEl) return;
  pipLangEl.textContent =
    sourceSel.value.toUpperCase() + '  →  ' + targetSel.value.toUpperCase();
}

/* ══ 타이머가 억제되는지 재는 자 ═══════════════════════════
   크롬은 5분 넘게 숨겨진 탭의 타이머를 1분에 한 번 수준으로 늦춥니다.
   그러면 감시견이 제때 못 돌아 자막이 죽어도 한참 뒤에야 살아납니다.
   - 본 페이지 쪽과 PiP 창 쪽에서 각각 1초 타이머를 돌리며 실제 간격을 재고
   - 1분마다 콘솔에 요약을 찍습니다. 콘솔에서 pipTimerReport() 로도 봅니다. */
var probeParent = { name: '본 페이지', last: 0, gaps: [], timer: null };
var probePip    = { name: 'PiP 창',   last: 0, gaps: [], timer: null };

function probeTick(p) {
  var now = Date.now();
  if (p.last) {
    p.gaps.push(now - p.last);
    if (p.gaps.length > 400) p.gaps.shift();
  }
  p.last = now;
}
function probeSummary(p) {
  if (!p.gaps.length) return { 잰횟수: 0 };
  var max = 0, sum = 0;
  for (var i = 0; i < p.gaps.length; i++) { sum += p.gaps[i]; if (p.gaps[i] > max) max = p.gaps[i]; }
  return {
    잰횟수: p.gaps.length,
    평균ms: Math.round(sum / p.gaps.length),
    최대ms: max,
    억제의심: max >= 3000     // 1초 타이머가 3초 넘게 벌어졌다면 늦춰진 것입니다
  };
}
window.pipTimerReport = function () {
  return { 본페이지: probeSummary(probeParent), PiP창: probeSummary(probePip) };
};

var probeLogCount = 0;
function probeLogMaybe() {
  probeLogCount++;
  if (probeLogCount % 60 !== 0) return;          // 1분에 한 번만
  var r = window.pipTimerReport();
  console.log('[타이머 측정 ' + stamp() + '] 본 페이지 평균 ' + r.본페이지.평균ms
    + 'ms / 최대 ' + r.본페이지.최대ms + 'ms   |   PiP 창 평균 ' + r.PiP창.평균ms
    + 'ms / 최대 ' + r.PiP창.최대ms + 'ms'
    + (r.본페이지.억제의심 ? '   ⚠ 본 페이지 타이머가 늦춰지고 있습니다' : ''));
}

/* ── PiP 창 안에서 1초마다 도는 일 ────────────────────────
   PiP 창은 "항상 보이는 창"이라 크롬이 타이머를 늦추지 않습니다.
   그래서 본 페이지 감시견이 늦춰지더라도 여기서 대신 잡아냅니다.
   ※ 2단계 감시견 코드(startWatchdog)는 손대지 않았습니다.
     여기서는 이미 있는 reviveRecognition() 을 그대로 부를 뿐입니다.
     그 함수는 reviving 플래그로 중복 실행을 막으므로 겹쳐도 안전합니다. */
function pipTick() {
  probeTick(probePip);
  probeLogMaybe();

  // 정지 버튼 모양 맞추기 (본 페이지 updateSpeakUI 는 건드리지 않습니다)
  if (pipStopBtn) {
    pipStopBtn.disabled = !listening;
    pipStopBtn.style.opacity = listening ? '1' : '.45';
  }

  // ★ 백업 감시견
  if (isStoppedByUser || reviving || !lastEventAt) return;
  var idle = Date.now() - lastEventAt;
  if (idle < EVENT_SILENCE_LIMIT_MS) return;

  speechLog('⚠ PiP 백업 감시견: ' + (idle / 1000).toFixed(1)
    + '초 동안 이벤트가 없었습니다 → 되살립니다');
  reviveRecognition();
}

/* ── 창 열기 ──────────────────────────────────────────────
   ★ 반드시 클릭 핸들러 안에서 불러야 합니다.
     페이지가 열릴 때 저절로 부르면 브라우저가 막습니다. */
async function openPip() {
  if (!PIP_SUPPORTED) return;
  if (pipWin) { try { pipWin.focus(); } catch (e) {} return; }

  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: 560, height: 200 });
  } catch (e) {
    pipWin = null;
    setStatus('PiP 창을 열지 못했습니다: ' + (e && e.message ? e.message : e), 'err', true);
    return;
  }

  var d = pipWin.document;
  var c = pipColors();

  d.title = '자막';
  d.documentElement.style.cssText = 'height:100%;';
  d.body.style.cssText =
    'margin:0;height:100%;display:flex;flex-direction:column;overflow:hidden;'
    // 본 페이지와 같은 글꼴 차례입니다. 한글이 맑은 고딕으로 잘 떨어집니다.
    + "font-family:'Segoe UI','Malgun Gothic','Apple SD Gothic Neo',"
    + "'Noto Sans KR',system-ui,sans-serif;"
    + '-webkit-font-smoothing:antialiased;';

  /* 윗줄: 언어 조합 + 정지 버튼 */
  var bar = d.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:10px;'
    + 'padding:7px 14px;font-size:11px;border-bottom:1px solid ' + c.line + ';';

  pipLangEl = d.createElement('span');
  pipLangEl.style.cssText = 'letter-spacing:.08em;font-weight:600;';

  var spacer = d.createElement('span');
  spacer.style.cssText = 'flex:1 1 auto;';

  pipStopBtn = d.createElement('button');
  pipStopBtn.type = 'button';
  pipStopBtn.textContent = '정지';
  pipStopBtn.style.cssText = 'border:1px solid ' + c.line + ';border-radius:999px;'
    + 'padding:3px 13px;font-size:11px;font-weight:600;cursor:pointer;'
    + 'background:transparent;color:' + c.fail + ';font-family:inherit;';
  pipStopBtn.addEventListener('click', function () { stopListening(); });

  bar.appendChild(pipLangEl); bar.appendChild(spacer); bar.appendChild(pipStopBtn);

  /* 아랫칸: 자막. 아래쪽에 붙여서 위로 밀려 올라가게 합니다. */
  pipBody = d.createElement('div');
  pipBody.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;'
    + 'justify-content:flex-end;overflow:hidden;padding:8px 16px 12px;';

  d.body.appendChild(bar);
  d.body.appendChild(pipBody);

  /* ★ 요소를 통째로 옮깁니다 (복사가 아닙니다).
       그래서 기존 자막 로직이 계속 이 요소들을 갱신합니다. */
  pipBody.appendChild(captionsEl);
  pipBody.appendChild(interimEl);

  pipUpdateLang();
  pipRestyle();

  /* 자막이 바뀌면 다시 칠합니다.
     - childList : 자막이 새로 생기거나 지워질 때
     - class     : 번역 대기(···) → 번역 완료로 바뀔 때
     - 글자 변화 : 원문·번역 내용이 채워질 때
     style 속성은 일부러 지켜보지 않습니다. 그래야 무한 반복이 안 생깁니다. */
  pipCapObserver = new MutationObserver(pipRestyle);
  pipCapObserver.observe(captionsEl, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class']
  });
  pipCapObserver.observe(interimEl, { childList: true, characterData: true, subtree: true });

  /* 설정이 바뀌면 다시 칠합니다.
     applyPrefs() 가 body 의 class 와 data-* 를 바꾸므로 그걸 지켜보면 됩니다.
     덕분에 2.5단계 설정 코드를 한 줄도 고치지 않았습니다. */
  pipPrefObserver = new MutationObserver(pipRestyle);
  pipPrefObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-capsize', 'data-capmode', 'data-capcontent']
  });

  // 언어를 바꾸면 윗줄 표시도 바꿉니다
  sourceSel.addEventListener('change', pipUpdateLang);
  targetSel.addEventListener('change', pipUpdateLang);

  // 타이머 측정 시작 — 본 페이지와 PiP 창을 나란히 잽니다
  probeParent.last = 0; probeParent.gaps = [];
  probePip.last = 0;    probePip.gaps = [];
  probeLogCount = 0;
  clearInterval(probeParent.timer);
  probeParent.timer = setInterval(function () { probeTick(probeParent); }, WATCHDOG_MS);
  pipTimer = pipWin.setInterval(pipTick, WATCHDOG_MS);

  /* ★ 창이 닫힐 때 자막을 본 페이지로 되돌립니다.
       이게 없으면 창을 닫았을 때 본 페이지에서 자막이 사라진 것처럼 보입니다. */
  pipWin.addEventListener('pagehide', closePipCleanup);

  pipBtn.textContent = 'PiP 닫기';
  setStatus('자막을 별도 창으로 띄웠습니다. 다른 창을 봐도 계속 보입니다.', 'ok');
  speechLog('PiP 창 열림 — 자막 요소를 옮겼습니다');
}

/* ── 창 닫힘 뒷정리 ── */
function closePipCleanup() {
  if (!pipWin) return;

  try { pipWin.clearInterval(pipTimer); } catch (e) {}
  pipTimer = null;
  clearInterval(probeParent.timer);
  probeParent.timer = null;

  if (pipCapObserver)  { pipCapObserver.disconnect();  pipCapObserver = null; }
  if (pipPrefObserver) { pipPrefObserver.disconnect(); pipPrefObserver = null; }
  sourceSel.removeEventListener('change', pipUpdateLang);
  targetSel.removeEventListener('change', pipUpdateLang);

  // 발라둔 인라인 스타일을 모두 지웁니다. 그래야 본 페이지 CSS 가 다시 살아납니다.
  captionsEl.style.cssText = '';
  interimEl.style.cssText  = '';
  var kids = captionsEl.querySelectorAll('.caption, .src, .dst, .when');
  for (var i = 0; i < kids.length; i++) kids[i].style.cssText = '';

  // 자막을 원래 자리로 (speakEmpty 다음, 이 순서가 원래 순서입니다)
  var home = $('view-speak');
  home.appendChild(captionsEl);
  home.appendChild(interimEl);

  pipWin = null; pipBody = null; pipLangEl = null; pipStopBtn = null;
  pipBtn.textContent = 'PiP 창';
  scrollToBottom();
  speechLog('PiP 창 닫힘 — 자막을 본 페이지로 되돌렸습니다');
}

pipBtn.addEventListener('click', function () {
  if (pipWin) { try { pipWin.close(); } catch (e) { closePipCleanup(); } }
  else openPip();
});

// 지원하지 않는 브라우저에서는 버튼만 감춥니다. 나머지 기능은 그대로입니다.
if (!PIP_SUPPORTED) pipBtn.classList.add('hidden');

