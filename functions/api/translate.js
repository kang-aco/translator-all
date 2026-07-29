/**
 * Cloudflare Pages Function — 번역 중계기
 *
 * 주소: POST /api/translate
 *
 * 이 파일은 브라우저가 아니라 Cloudflare 서버에서 실행됩니다.
 * 그래서 여기서만 환경변수(env)에 든 API 키를 읽을 수 있고,
 * 키가 사용자 브라우저로 내려가지 않습니다.
 *
 * 필요한 환경변수 (Cloudflare 대시보드에서 등록):
 *   DEEPL_API_KEY             — DeepL 키  (셋 중 하나만 있어도 동작)
 *   GOOGLE_TRANSLATE_API_KEY  — Google Cloud Translation 키
 *   GEMINI_API_KEY            — Gemini 키 (4단계에서 추가)
 *   TRANSLATE_ENGINE          — (선택) "deepl" / "google" / "gemini" 로 강제 지정
 *   LLM_MODEL                 — (선택) Gemini 모델 이름. 기본 gemini-3.1-flash-lite-preview
 *                                모델은 단종될 수 있습니다. 아래 DEFAULT_LLM_MODEL
 *                                주석을 꼭 읽어보세요.
 */

// 화면에서 쓰는 짧은 코드 -> 각 API가 요구하는 코드로 바꾸는 표
const DEEPL_TARGET = {
  ko: 'KO', en: 'EN-US', ja: 'JA', zh: 'ZH', es: 'ES', fr: 'FR',
  de: 'DE', ru: 'RU', pt: 'PT-BR', it: 'IT', id: 'ID', nl: 'NL',
};
const DEEPL_SOURCE = {
  ko: 'KO', en: 'EN', ja: 'JA', zh: 'ZH', es: 'ES', fr: 'FR',
  de: 'DE', ru: 'RU', pt: 'PT', it: 'IT', id: 'ID', nl: 'NL',
};
const GOOGLE_LANG = {
  ko: 'ko', en: 'en', ja: 'ja', zh: 'zh-CN', es: 'es', fr: 'fr',
  de: 'de', ru: 'ru', pt: 'pt', it: 'it', id: 'id', nl: 'nl',
};

const MAX_CHARS = 3000;

/* ── 4단계: LLM(Gemini) 맥락 번역 설정 ─────────────────────
   LLM = Large Language Model(대규모 언어 모델). 챗봇에 쓰이는 그 모델입니다.
   기존 번역기는 "글자 → 글자"만 바꾸지만, LLM 은 앞뒤 맥락을 읽고
   문장 경계를 스스로 판단할 수 있습니다. 음성 인식 결과처럼
   구두점이 하나도 없는 글에는 이 차이가 큽니다. */

// 사람이 읽을 수 있는 언어 이름. 지시문에 넣어줘야 LLM 이 정확히 알아듣습니다.
const LLM_LANG_NAME = {
  ko: '한국어', en: '영어', ja: '일본어', zh: '중국어(간체)', es: '스페인어',
  fr: '프랑스어', de: '독일어', ru: '러시아어', pt: '포르투갈어',
  it: '이탈리아어', id: '인도네시아어', nl: '네덜란드어', auto: '(자동 감지)',
};

/* ★ 기본 모델 이름 — 단종되면 여기도 함께 고쳐야 합니다 ★
 *
 * 환경변수 LLM_MODEL 로 덮어쓸 수 있지만, 그걸 안 넣으면 이 값이 쓰입니다.
 * 즉 이 값이 낡으면 아무것도 안 하는 사용자는 그대로 고장납니다.
 *
 * [모델이 단종되면 어떻게 보이는가]
 * 호출이 404 로 실패하고, 아래 대체 고리를 타고 조용히 구글 번역으로
 * 넘어갑니다. 자막은 계속 나오므로 겉으로는 멀쩡해 보이지만
 * 맥락 번역은 하나도 안 됩니다. 콘솔의
 *   ⚠ gemini 실패로 대체: Gemini 오류 (HTTP 404)
 * 가 유일한 단서입니다.
 *
 * [그래서 지켜야 할 것]
 * 새 모델로 갈아탈 때는 Cloudflare 환경변수 LLM_MODEL 만 바꾸지 말고
 * 반드시 이 기본값도 같이 고쳐 두세요. 그래야 환경변수를 안 넣은
 * 사람이나 다른 곳에 새로 배포했을 때도 정상 동작합니다.
 *
 * [이력]
 * gemini-2.5-flash — 신규 사용자에게 막혀 404. 2026-07-29 교체함.
 * gemini-3.6-flash — 더 가볍고 빠른 lite 로 옮김. 2026-07-29 교체함.
 *
 * ※ 지금 값은 이름에 preview 가 붙은 미리보기 모델입니다.
 *   미리보기 모델은 정식 모델보다 빨리 없어질 수 있으니,
 *   콘솔에 404 가 보이면 이 줄부터 의심하세요.
 */
const DEFAULT_LLM_MODEL = 'gemini-3.1-flash-lite-preview';

const MAX_CONTEXT_CHARS = 1500;   // 맥락 문장이 아무리 많아도 이만큼까지만 보냅니다

/** JSON 응답을 만드는 잔심부름 함수 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** &amp; 같은 HTML 엔티티를 원래 글자로 되돌림 (Google 응답 대비) */
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ── DeepL 호출 ──────────────────────────────────────────────
async function translateWithDeepL(key, text, source, target) {
  const targetCode = DEEPL_TARGET[target];
  if (!targetCode) throw new Error('DeepL이 지원하지 않는 목표 언어입니다: ' + target);

  const body = { text: [text], target_lang: targetCode };
  // source 가 'auto' 면 source_lang 을 빼서 DeepL이 알아서 감지하게 둡니다.
  if (source && source !== 'auto') {
    const sourceCode = DEEPL_SOURCE[source];
    if (sourceCode) body.source_lang = sourceCode;
  }

  // 무료 키는 ':fx' 로 끝납니다. 그에 맞춰 주소를 고릅니다.
  const endpoint = key.trim().endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'DeepL-Auth-Key ' + key.trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error('DeepL 오류 (HTTP ' + res.status + '): ' + raw.slice(0, 200));
  }

  const data = JSON.parse(raw);
  const first = data.translations && data.translations[0];
  if (!first) throw new Error('DeepL 응답에 번역문이 없습니다.');

  return {
    text: first.text,
    detectedSource: (first.detected_source_language || '').toLowerCase() || null,
    engine: 'deepl',
  };
}

// ── Google 호출 ─────────────────────────────────────────────
async function translateWithGoogle(key, text, source, target) {
  const targetCode = GOOGLE_LANG[target];
  if (!targetCode) throw new Error('지원하지 않는 목표 언어입니다: ' + target);

  const body = { q: text, target: targetCode, format: 'text' };
  if (source && source !== 'auto' && GOOGLE_LANG[source]) {
    body.source = GOOGLE_LANG[source];
  }

  const res = await fetch(
    'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key.trim()),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const raw = await res.text();
  if (!res.ok) {
    throw new Error('Google 오류 (HTTP ' + res.status + '): ' + raw.slice(0, 200));
  }

  const data = JSON.parse(raw);
  const first = data.data && data.data.translations && data.data.translations[0];
  if (!first) throw new Error('Google 응답에 번역문이 없습니다.');

  return {
    text: decodeEntities(first.translatedText),
    detectedSource: first.detectedSourceLanguage || null,
    engine: 'google',
  };
}

// ── Gemini(LLM) 호출 ────────────────────────────────────────

/** LLM 에게 줄 지시문을 만듭니다.
 *  context 는 "직전에 확정된 원문들"입니다. 번역 대상이 아니라
 *  대명사와 말투를 이어붙이기 위한 참고 자료입니다. */
function buildLlmPrompt(text, source, target, context) {
  const srcName = LLM_LANG_NAME[source] || source;
  const dstName = LLM_LANG_NAME[target] || target;

  let prompt =
    '당신은 실시간 방송 자막 번역가입니다.\n' +
    '\n' +
    '[입력의 성질]\n' +
    '- 아래 원문은 음성 인식(받아쓰기) 결과입니다. 마침표도 쉼표도 없습니다.\n' +
    '- 여러 문장이 한 덩어리로 뭉쳐 있을 수 있습니다.\n' +
    '- ★ 이 원문은 실시간 받아쓰기를 도중에 잘라낸 조각입니다.\n' +
    '  문장 중간에서 시작할 수도 있고, 문장 중간에서 끝날 수도 있습니다.\n' +
    '- 원어는 ' + srcName + ' 입니다.\n' +
    '\n' +
    '[할 일]\n' +
    '1. 문맥을 보고 문장 경계를 스스로 판단하세요.\n' +
    '2. 원문을 자연스러운 문장 단위로 나누고, 각 문장에 구두점을 복원하세요.\n' +
    '   낱말 자체를 바꾸거나 없는 내용을 채워 넣지는 마세요.\n' +
    '3. 나눈 문장을 각각 ' + dstName + ' 로 번역하세요.\n' +
    '\n' +
    '[★ 잘린 조각 다루기 — 가장 자주 틀리는 부분]\n' +
    '- 마지막 부분이 문장으로 완결되지 않았다고 판단되면, 억지로 마침표를\n' +
    '  붙여 완결된 문장처럼 만들지 마세요. 끝을 그대로 열어 두세요.\n' +
    '  예: "those concerns all taken" 은 뒤에 말이 더 이어질 조각입니다.\n' +
    '  여기에 마침표를 찍어 "those concerns all taken." 으로 만들면 안 됩니다.\n' +
    '- 첫 부분이 앞 맥락에서 이어지는 조각이면 그 흐름에 맞춰 번역하세요.\n' +
    '  새 문장이 시작된 것처럼 처음부터 다시 시작하지 마세요.\n' +
    '- 없는 낱말을 보태 문장을 억지로 끝맺지 마세요. 조각은 조각인 채로 둡니다.\n' +
    '\n' +
    '[번역 방침]\n' +
    '- 화면에 잠깐 스쳐 가는 자막입니다. 짧고 읽기 쉬운 구어체로 옮기세요.\n' +
    '- 직역해서 딱딱해지느니 뜻이 통하게 다듬으세요.\n' +
    '- 앞 문장에서 이어지는 대명사와 말투를 일관되게 유지하세요.\n' +
    '\n' +
    '[출력 형식]\n' +
    '설명, 인사, 사족 없이 아래 JSON 만 출력하세요.\n' +
    '{"segments":[{"source":"구두점을 복원한 원문","translated":"번역문"}]}\n';

  if (context && context.length) {
    prompt +=
      '\n[앞 맥락 — 참고용]\n' +
      '아래는 바로 앞에 지나간 내용입니다. 흐름을 파악하는 데만 쓰세요.\n' +
      '번역할 원문이 이 맥락의 마지막 문장에서 곧바로 이어지는 조각일 수 있습니다.\n' +
      '그럴 때는 끊긴 자리에서 이어받아 번역하세요.\n' +
      '★ 이 부분은 절대 번역해서 돌려주지 마세요. 출력에 포함하면 안 됩니다.\n' +
      context.join('\n') + '\n';
  }

  prompt += '\n[번역할 원문 — 이 부분만 출력하세요]\n' + text + '\n';
  return prompt;
}

/** LLM 이 ```json 같은 코드블록 표시를 붙여 보내는 경우가 있어 벗겨냅니다. */
function stripCodeFence(s) {
  let t = String(s).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '');   // 앞의 ``` 또는 ```json 제거
    const end = t.lastIndexOf('```');
    if (end !== -1) t = t.slice(0, end);
  }
  return t.trim();
}

async function translateWithGemini(key, model, text, source, target, context) {
  if (!LLM_LANG_NAME[target]) throw new Error('지원하지 않는 목표 언어입니다: ' + target);

  const prompt = buildLlmPrompt(text, source, target, context);

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key.trim()),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          // JSON 으로만 답하라고 못 박습니다. 그래도 코드블록이 붙는 경우가 있어
          // 위의 stripCodeFence 로 한 번 더 걸러냅니다.
          responseMimeType: 'application/json',
          temperature: 0.2,          // 자막이므로 튀지 않게 낮게
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  const raw = await res.text();
  if (!res.ok) {
    throw new Error('Gemini 오류 (HTTP ' + res.status + '): ' + raw.slice(0, 200));
  }

  let body;
  try { body = JSON.parse(raw); }
  catch (e) { throw new Error('Gemini 응답이 JSON 이 아닙니다.'); }

  const cand = body.candidates && body.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  const answer = part && part.text;
  if (!answer) {
    // 안전 필터에 걸리거나 토큰이 모자라면 여기로 옵니다.
    throw new Error('Gemini 응답에 내용이 없습니다. (' + (cand && cand.finishReason || '이유 불명') + ')');
  }

  let parsed;
  try { parsed = JSON.parse(stripCodeFence(answer)); }
  catch (e) { throw new Error('Gemini 가 준 JSON 을 읽지 못했습니다: ' + answer.slice(0, 120)); }

  const list = Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!list || !list.length) throw new Error('Gemini 응답에 segments 가 없습니다.');

  // 형식이 조금 어긋나도 쓸 수 있는 것만 골라냅니다
  const segments = [];
  for (const seg of list) {
    if (!seg) continue;
    const t = typeof seg.translated === 'string' ? seg.translated.trim() : '';
    if (!t) continue;
    segments.push({
      source: typeof seg.source === 'string' ? seg.source.trim() : '',
      translated: t,
    });
  }
  if (!segments.length) throw new Error('Gemini 응답에 쓸 수 있는 번역문이 없습니다.');

  return {
    // 문장별로 나눈 결과. 화면에서 자막 줄을 여러 개 만들 때 씁니다.
    segments,
    // 나누지 않고 한 덩어리로 쓰는 곳(채팅 모드)을 위해 합친 것도 같이 줍니다.
    text: segments.map((s) => s.translated).join(' '),
    detectedSource: null,
    engine: 'gemini',
  };
}

// ── /api/translate 진입점 ───────────────────────────────────
// onRequest 는 모든 방식(GET/POST/…)의 요청을 받습니다.
// POST 가 아니면 여기서 잘라내고, POST 만 아래 handlePost 로 넘깁니다.
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ error: 'POST 로만 요청해 주세요.' }, 405);
  }
  return handlePost(context);
}

async function handlePost({ request, env }) {
  try {
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: '요청 형식이 잘못되었습니다. (JSON 아님)' }, 400);
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const source = payload.source || 'auto';
    const target = payload.target || 'ko';

    /* 4단계: 맥락 문장 받기.
       화면이 보내준 "직전에 확정된 원문들"입니다. 번역 대상이 아닙니다.
       길이가 무한정 늘지 않도록 뒤에서부터 MAX_CONTEXT_CHARS 만큼만 씁니다. */
    let context = [];
    if (Array.isArray(payload.context)) {
      let used = 0;
      for (let i = payload.context.length - 1; i >= 0; i--) {
        const c = typeof payload.context[i] === 'string' ? payload.context[i].trim() : '';
        if (!c) continue;
        if (used + c.length > MAX_CONTEXT_CHARS) break;
        used += c.length;
        context.unshift(c);
      }
    }

    if (!text) return json({ error: '번역할 내용이 비어 있습니다.' }, 400);
    if (text.length > MAX_CHARS) {
      return json({ error: '너무 깁니다. ' + MAX_CHARS + '자 이하로 나눠서 보내주세요.' }, 400);
    }
    if (source === target) {
      return json({ error: '원어와 목표어가 같습니다.' }, 400);
    }

    /* 어떤 엔진을 쓸지 결정합니다.
       강제 지정(TRANSLATE_ENGINE) > DeepL > Google > Gemini 순서입니다.
       ★ Gemini 를 맨 뒤에 둔 이유:
         TRANSLATE_ENGINE 을 지우기만 하면 예전 동작(구글)으로 즉시 돌아갑니다.
         환경변수 하나로 되돌릴 수 있게 해달라는 요구를 이렇게 지켰습니다. */
    const forced = (env.TRANSLATE_ENGINE || '').toLowerCase();
    const hasDeepL = !!env.DEEPL_API_KEY;
    const hasGoogle = !!env.GOOGLE_TRANSLATE_API_KEY;
    const hasGemini = !!env.GEMINI_API_KEY;
    const llmModel = env.LLM_MODEL || DEFAULT_LLM_MODEL;

    let engine;
    if (forced === 'deepl' && hasDeepL) engine = 'deepl';
    else if (forced === 'google' && hasGoogle) engine = 'google';
    else if (forced === 'gemini' && hasGemini) engine = 'gemini';
    else if (hasDeepL) engine = 'deepl';
    else if (hasGoogle) engine = 'google';
    else if (hasGemini) engine = 'gemini';
    else {
      return json({
        error: '서버에 번역 API 키가 등록되어 있지 않습니다. '
             + 'Cloudflare Pages 환경변수에 DEEPL_API_KEY, GOOGLE_TRANSLATE_API_KEY, '
             + 'GEMINI_API_KEY 중 하나를 넣어주세요.',
      }, 503);
    }

    /** 엔진 이름 하나로 실제 호출을 골라 부르는 잔심부름 함수 */
    function runEngine(name) {
      if (name === 'deepl')  return translateWithDeepL(env.DEEPL_API_KEY, text, source, target);
      if (name === 'google') return translateWithGoogle(env.GOOGLE_TRANSLATE_API_KEY, text, source, target);
      return translateWithGemini(env.GEMINI_API_KEY, llmModel, text, source, target, context);
    }

    /* ★ 실패 시 대비 (요구사항 5)
       LLM 호출이 실패하거나 응답 형식이 깨지면 기존 번역기로 넘어갑니다.
       자막이 아예 안 나오는 상황을 막기 위한 안전망입니다.
       Gemini 는 무료 등급이라 사용량이 몰리면 429(초과)가 잘 나므로
       이 안전망이 실제로 자주 쓰일 수 있습니다. */
    const backups = ['deepl', 'google', 'gemini'].filter((name) => {
      if (name === engine) return false;
      if (name === 'deepl')  return hasDeepL;
      if (name === 'google') return hasGoogle;
      return hasGemini;
    });

    let result;
    let fallbackFrom = null;
    let fallbackReason = null;
    try {
      result = await runEngine(engine);
    } catch (primaryError) {
      let lastError = primaryError;
      for (const backup of backups) {
        try {
          result = await runEngine(backup);
          fallbackFrom = engine;
          fallbackReason = (primaryError && primaryError.message) || '알 수 없는 오류';
          break;
        } catch (e) { lastError = e; }
      }
      if (!result) throw lastError;
    }

    return json({
      translated: result.text,
      // 문장별로 나뉜 결과. Gemini 일 때만 들어 있고, 나머지 엔진에서는 null 입니다.
      segments: result.segments || null,
      detectedSource: result.detectedSource,
      engine: result.engine,
      model: result.engine === 'gemini' ? llmModel : null,
      fallbackFrom,
      fallbackReason,
      source,
      target,
    });
  } catch (err) {
    // 여기까지 온 오류는 화면에 문구로만 보여주고 앱은 계속 살아 있게 합니다.
    return json({ error: (err && err.message) ? err.message : '알 수 없는 번역 오류' }, 502);
  }
}
