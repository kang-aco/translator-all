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
 *   DEEPL_API_KEY             — DeepL 키  (둘 중 하나만 있어도 동작)
 *   GOOGLE_TRANSLATE_API_KEY  — Google Cloud Translation 키
 *   TRANSLATE_ENGINE          — (선택) "deepl" 또는 "google" 로 강제 지정
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

    if (!text) return json({ error: '번역할 내용이 비어 있습니다.' }, 400);
    if (text.length > MAX_CHARS) {
      return json({ error: '너무 깁니다. ' + MAX_CHARS + '자 이하로 나눠서 보내주세요.' }, 400);
    }
    if (source === target) {
      return json({ error: '원어와 목표어가 같습니다.' }, 400);
    }

    // 어떤 엔진을 쓸지 결정: 강제 지정 > DeepL > Google
    const forced = (env.TRANSLATE_ENGINE || '').toLowerCase();
    const hasDeepL = !!env.DEEPL_API_KEY;
    const hasGoogle = !!env.GOOGLE_TRANSLATE_API_KEY;

    let engine;
    if (forced === 'deepl' && hasDeepL) engine = 'deepl';
    else if (forced === 'google' && hasGoogle) engine = 'google';
    else if (hasDeepL) engine = 'deepl';
    else if (hasGoogle) engine = 'google';
    else {
      return json({
        error: '서버에 번역 API 키가 등록되어 있지 않습니다. '
             + 'Cloudflare Pages 환경변수에 DEEPL_API_KEY 또는 GOOGLE_TRANSLATE_API_KEY 를 넣어주세요.',
      }, 503);
    }

    let result;
    try {
      result = engine === 'deepl'
        ? await translateWithDeepL(env.DEEPL_API_KEY, text, source, target)
        : await translateWithGoogle(env.GOOGLE_TRANSLATE_API_KEY, text, source, target);
    } catch (primaryError) {
      // 기본 엔진이 실패했고 다른 키가 있으면 한 번 더 시도합니다.
      const canFallback = (engine === 'deepl' && hasGoogle) || (engine === 'google' && hasDeepL);
      if (!canFallback) throw primaryError;

      result = engine === 'deepl'
        ? await translateWithGoogle(env.GOOGLE_TRANSLATE_API_KEY, text, source, target)
        : await translateWithDeepL(env.DEEPL_API_KEY, text, source, target);
      result.fallbackFrom = engine;
    }

    return json({
      translated: result.text,
      detectedSource: result.detectedSource,
      engine: result.engine,
      fallbackFrom: result.fallbackFrom || null,
      source,
      target,
    });
  } catch (err) {
    // 여기까지 온 오류는 화면에 문구로만 보여주고 앱은 계속 살아 있게 합니다.
    return json({ error: (err && err.message) ? err.message : '알 수 없는 번역 오류' }, 502);
  }
}
