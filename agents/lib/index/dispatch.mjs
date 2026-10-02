/*
 * 문자열 디스패치와 결과 소비 — 화면이 서버를 "문자열로" 부르고 결과를 "위치로" 읽는 레거시 구조를 잇는다.
 *
 * 실측(실제 레거시 xu25 · xu25-client, 2026-10 비교 실험):
 *   화면  $.ajax({ url: CONTEXT_PATH + "/TransData.do", data: "worker=CourseSessionService&action=listCourseIdParentTree&…", success: onResult })
 *   jar   AjaxController 가 worker → 빈, action → do + 대문자 메서드로 부른다(소스 없음)
 *   서버  CourseSessionService.doListCourseIdParentTree → dataSet.set("rtInfo", query("…_S01"))
 *   화면  onResult(request) { var data = transData(request); … data.rtInfo[1][2] … data.rtInfo[1][1] }
 * 호출이 코드에 없어 인덱스가 이 메서드를 "호출자 없는 죽은 코드" 로 봤고(axnavi 가 삭제를 진행한 원인),
 * 결과를 이름이 아니라 위치로 읽어 SELECT 첫 컬럼을 빼면 화면 24곳이 조용히 깨지는데 아무도 몰랐다.
 *
 * 이 파일은 의존성 없는 순수 함수만 둔다. build-index.mjs 가 파일마다 부르고(추출), aggregate 와
 * query-index 가 저장소를 넘어 잇는다(해석).
 */

/* ───────────────────────── 공통 ───────────────────────── */

/** @param {string} text @param {number} open  `{` 위치 @returns {number} 닫는 `}` 다음 위치 */
function matchingBrace(text, open) {
  if (open < 0 || text[open] !== "{") return text.length;
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** @param {string} text @returns {(offset: number) => number} */
function lineAt(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 대문자로 시작하게 — `listX` → `ListX`. */
export const capitalize = (/** @type {string} */ s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ───────────────────────── SQL SELECT 컬럼 ───────────────────────── */

/**
 * 최상위 SELECT 목록의 컬럼. 위치로 읽는 화면이 몇 번째 컬럼을 읽는지 이름으로 바꾸는 데 쓴다.
 * 별칭이 있으면 별칭, 단순 컬럼이면 그 이름, 식이면 식 자체(60자)를 이름으로 둔다.
 * iBatis 동적 태그(`<isNotEmpty>` 등)·`$1{…}` 같은 자체 치환은 목록 밖이면 상관없고, 목록 안이면 그대로 남긴다.
 * @param {string} sql
 * @returns {Array<{ index: number, name: string, expr: string }>}
 */
export function selectColumns(sql) {
  const text = String(sql).replace(/<!\[CDATA\[|\]\]>/g, " ").replace(/<[^>]+>/g, " ");
  const head = /\bselect\b(\s+(?:distinct|all)\b)?/i.exec(text);
  if (!head) return [];
  let depth = 0;
  let quote = "";
  let end = -1;
  const from = head.index + head[0].length;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === "\"") { quote = c; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && /\bfrom\b/i.test(text.slice(i, i + 5)) && /[\s)]/.test(text[i - 1] ?? " ") && /[\s(]/.test(text[i + 4] ?? " ")) { end = i; break; }
  }
  if (end < 0) return [];
  const list = text.slice(from, end);
  /** @type {string[]} */
  const parts = [];
  let buf = "";
  depth = 0;
  quote = "";
  for (const c of list) {
    if (quote) { buf += c; if (c === quote) quote = ""; continue; }
    if (c === "'" || c === "\"") { quote = c; buf += c; continue; }
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((raw, index) => {
    const expr = raw.replace(/\s+/g, " ").trim();
    const alias = /\s+(?:as\s+)?"?([A-Za-z_][\w$#]*)"?$/i.exec(expr);
    const simple = /^(?:[A-Za-z_][\w$#]*\.)?([A-Za-z_][\w$#]*)$/.exec(expr);
    const tailIsFunctionClose = /\)\s*$/.test(expr);
    const name = simple ? (simple[1] ?? expr) : alias && !tailIsFunctionClose ? (alias[1] ?? expr) : expr.slice(0, 60);
    return { index, name, expr: expr.slice(0, 200) };
  });
}

/* ───────────────────────── 서버: 결과 이름 ───────────────────────── */

const QUERY_CALL = /\b(?:query|queryForList|queryForObject|queryForMap|select|selectList|selectOne|selectMap|list|executeQuery)\s*\(\s*["']([\w.\-]+)["']/;

/**
 * 메서드가 쿼리 결과를 어떤 이름으로 내보내는지. `rtInfo = (ResultTable) dao.query("X_S01", …)` 다음
 * `dataSet.set("rtInfo", rtInfo)` → { key: "rtInfo", sql_id: "X_S01" }. 한 줄 형태(`set("k", dao.query("X"))`)도 본다.
 * @param {string} clean  주석을 비운 본문
 * @param {Array<{ id: string, start: number, end: number }>} methods
 * @returns {Array<{ method: string, key: string, sql_id: string, line: number }>}
 */
export function extractResultKeys(clean, methods) {
  if (!/\.(?:set|put|addAttribute|addObject|setAttribute)\s*\(/.test(clean)) return [];
  const at = lineAt(clean);
  /** @type {Array<{ method: string, key: string, sql_id: string, line: number }>} */
  const out = [];
  for (const m of methods) {
    if (!(m.end > m.start)) continue;
    const body = clean.slice(m.start, m.end);
    /** @type {Map<string, string>} */
    const varSql = new Map();
    for (const assign of body.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:\([\w<>.,\s\[\]]+\)\s*)?[\w.]+\s*\.\s*(\w+)\s*\(\s*["']([\w.\-]+)["']/g)) {
      if (QUERY_CALL.test(`${assign[2]}("${assign[3]}"`)) varSql.set(/** @type {string} */ (assign[1]), /** @type {string} */ (assign[3]));
    }
    for (const put of body.matchAll(/\.(?:set|put|addAttribute|addObject|setAttribute)\s*\(\s*["']([\w.\-]+)["']\s*,\s*([^;]+?)\)\s*;/g)) {
      const key = /** @type {string} */ (put[1]);
      const value = /** @type {string} */ (put[2]).trim();
      const direct = QUERY_CALL.exec(value);
      const sql = direct ? direct[1] : varSql.get(value.replace(/^\([\w<>.\s]+\)\s*/, ""));
      if (sql) out.push({ method: m.id, key, sql_id: sql, line: at(m.start + (put.index ?? 0)) });
    }
  }
  return out;
}

/* ───────────────────────── 화면: 문자열 디스패치 호출 ───────────────────────── */

/**
 * @typedef {object} ResultRead
 * @property {string | null} key   읽는 결과 이름(`rtInfo`). 결과 객체를 그대로 인덱싱하면 null
 * @property {number | null} row
 * @property {number | null} col   위치로 읽으면 컬럼 번호(0부터)
 * @property {string | null} name  이름으로 읽으면 컬럼 이름
 * @property {number} line
 * @property {string} text         읽는 표현 그대로
 * @property {string} [via]        콜백이 넘겨받아 읽은 함수
 */

/**
 * @typedef {object} DispatchCall
 * @property {string} file
 * @property {number} line
 * @property {string | null} function     호출이 든 함수
 * @property {string | null} [function_id] 그 함수의 노드 id(인덱스 안)
 * @property {string | null} endpoint     부르는 주소(쿼리 문자열 · 컨텍스트 경로 변수 제외)
 * @property {Record<string, string>} params  식별자 값을 가진 파라미터(`worker`·`action` …)
 * @property {string | null} callback     결과를 받는 함수(이름 · "(inline)")
 * @property {ResultRead[]} reads
 */

const ENDPOINT_LIT = /["'`]((?:\.{0,2}\/)?[\w\-./]*\/?[\w\-]+\.(?:do|action|json|ajax|jsp|asp|aspx|php))(?:\?[^"'`]*)?["'`]/g;

/**
 * 결과를 읽는 표현. `data.rtInfo[1][2]`, `rt[1][2]`(rt = data.rtInfo), `data.rtInfo[i]["COL"]`.
 * @param {string} body
 * @param {string} paramName  콜백 매개변수 이름(없으면 "")
 * @param {number} offset     body 가 파일에서 시작하는 위치
 * @param {(offset: number) => number} at
 * @returns {ResultRead[]}
 */
function readsIn(body, paramName, offset, at) {
  /** @type {Map<string, string>} */
  const alias = new Map();
  for (const m of body.matchAll(/\b(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*;/g)) {
    alias.set(/** @type {string} */ (m[1]), /** @type {string} */ (m[3]));
  }
  /** @type {ResultRead[]} */
  const reads = [];
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\[\s*(\d+|[A-Za-z_$][\w$]*)\s*\]\[\s*(?:(\d+)|["']([A-Za-z_][\w$]*)["'])\s*\]/g)) {
    const base = /** @type {string} */ (m[1]);
    const key = m[2] ?? alias.get(base) ?? null;
    if (!m[2] && !alias.has(base) && base !== paramName && !/^(?:data|result|res|ret|rs|json|obj)$/i.test(base)) continue;
    const row = m[3] !== undefined && /^\d+$/.test(m[3]) ? Number(m[3]) : null;
    reads.push({
      key, row,
      col: m[4] !== undefined ? Number(m[4]) : null,
      name: m[5] ?? null,
      line: at(offset + (m.index ?? 0)),
      text: m[0],
    });
  }
  return reads;
}

/**
 * 이름으로 함수 본문을 찾는다(`function f(a){…}` · `f = function(a){…}` · `f: function(a){…}`).
 * @param {string} clean
 * @param {string} name
 * @returns {{ param: string, start: number, end: number } | null}
 */
function functionBody(clean, name) {
  const esc = name.replace(/[$]/g, "\\$");
  const re = new RegExp(`(?:\\bfunction\\s+${esc}\\s*\\(([^)]*)\\)|\\b${esc}\\s*[:=]\\s*function\\s*\\(([^)]*)\\))\\s*\\{`, "g");
  const m = re.exec(clean);
  if (!m) return null;
  const open = (m.index ?? 0) + m[0].length - 1;
  const param = ((m[1] ?? m[2] ?? "").split(",")[0] ?? "").trim();
  return { param, start: open, end: matchingBrace(clean, open) };
}

/**
 * 콜백 본문과 그 본문이 결과를 넘겨 부르는 함수(한 단계)의 읽기.
 * @param {string} clean
 * @param {{ param: string, start: number, end: number }} fn
 * @param {(offset: number) => number} at
 * @param {number} depth
 * @param {Set<string>} seen
 */
function callbackReads(clean, fn, at, depth = 0, seen = new Set()) {
  const body = clean.slice(fn.start, fn.end);
  const reads = readsIn(body, fn.param, fn.start, at);
  if (depth >= 2) return reads;
  /* `var data = transData(request)` 처럼 결과를 다른 이름에 담아 넘기는 것까지 넘겨받은 값으로 본다. */
  const carriers = new Set([fn.param].filter(Boolean));
  for (const m of body.matchAll(/\b(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*[\w$.]+\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (carriers.has(/** @type {string} */ (m[2]))) carriers.add(/** @type {string} */ (m[1]));
  }
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) {
    const callee = /** @type {string} */ (m[1]);
    const arg = /** @type {string} */ (m[2]).split(".")[0] ?? "";
    if (!carriers.has(arg) || seen.has(callee) || /^(?:if|for|while|switch|alert|transData|parseInt|String|Number|JSON|console)$/.test(callee)) continue;
    const inner = functionBody(clean, callee);
    if (!inner) continue;
    seen.add(callee);
    for (const r of callbackReads(clean, inner, at, depth + 1, seen)) reads.push({ ...r, via: r.via ?? callee });
  }
  return reads;
}

/**
 * 파라미터 문자열(`worker=X&action=Y&id="+v`)에서 식별자 값을 가진 쌍.
 * @param {string} literal
 * @returns {Record<string, string>}
 */
function queryParams(literal) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of literal.matchAll(/(?:^|[?&])([A-Za-z_][\w]*)=([A-Za-z_][\w.]*)(?=&|$)/g)) out[/** @type {string} */ (m[1])] = /** @type {string} */ (m[2]);
  return out;
}

/**
 * 화면 파일의 문자열 디스패치 호출. 파라미터 리터럴(`worker=…&action=…`)이 닻이다 — 주소는 변수에 담기는
 * 일이 많지만 파라미터는 거의 늘 리터럴로 남는다. 주소 · 콜백은 같은 함수 안에서 가장 가까운 것을 잡는다.
 * @param {string} clean  주석을 비운 본문(오프셋은 원문과 같다)
 * @param {string} rel
 * @param {Array<{ id: string, name?: string, start: number, end: number }>} [methods]  JS 함수 범위(있으면)
 * @returns {DispatchCall[]}
 */
export function extractDispatchCalls(clean, rel, methods = []) {
  if (!/[A-Za-z_]\w*=[A-Za-z_][\w.]*&[A-Za-z_]\w*=/.test(clean) && !/data\s*:\s*\{/.test(clean)) return [];
  const at = lineAt(clean);
  /** @type {DispatchCall[]} */
  const calls = [];
  /** @type {Array<{ params: Record<string, string>, start: number }>} */
  const anchors = [];
  for (const lit of clean.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const content = /** @type {string} */ (lit[2]);
    if (!content.includes("=")) continue;
    const params = queryParams(content.replace(/^[^?]*\?/, ""));
    if (Object.keys(params).length >= 2) anchors.push({ params, start: lit.index ?? 0 });
  }
  for (const obj of clean.matchAll(/\bdata\s*:\s*\{([^{}]{0,600})\}/g)) {
    /** @type {Record<string, string>} */
    const params = {};
    for (const p of /** @type {string} */ (obj[1]).matchAll(/["']?([A-Za-z_]\w*)["']?\s*:\s*["']([A-Za-z_][\w.]*)["']/g)) params[/** @type {string} */ (p[1])] = /** @type {string} */ (p[2]);
    if (Object.keys(params).length >= 2) anchors.push({ params, start: obj.index ?? 0 });
  }
  for (const anchor of anchors) {
    const owner = methods.filter((m) => m.start <= anchor.start && anchor.start < m.end).sort((a, b) => b.start - a.start)[0] ?? null;
    const lo = owner ? owner.start : Math.max(0, anchor.start - 1500);
    const hi = owner ? owner.end : Math.min(clean.length, anchor.start + 1500);
    const scope = clean.slice(lo, hi);
    /* 주소 — 가장 가까운 `.do` 류 리터럴 */
    let endpoint = null;
    let best = Infinity;
    for (const e of scope.matchAll(ENDPOINT_LIT)) {
      const d = Math.abs(lo + (e.index ?? 0) - anchor.start);
      if (d < best) { best = d; endpoint = (e[1] ?? "").replace(/^\.{0,2}/, ""); }
    }
    if (endpoint && !endpoint.startsWith("/")) endpoint = `/${endpoint}`;
    /* 콜백 — 파라미터 뒤쪽의 success: / .done( / $.post(url, data, cb) / f(url, pars, cb) */
    const after = clean.slice(anchor.start, Math.min(hi, anchor.start + 1500));
    let callback = null;
    let fn = null;
    let cb = /\bsuccess\s*:\s*(?:function\s*\(\s*([A-Za-z_$][\w$]*)?[^)]*\)\s*\{|([A-Za-z_$][\w$]*))|\.(?:done|then)\s*\(\s*(?:function\s*\(\s*([A-Za-z_$][\w$]*)?[^)]*\)\s*\{|([A-Za-z_$][\w$]*))/.exec(after);
    let cbBase = anchor.start;
    if (!cb) {
      /* `$.post(url, "worker=…", cb)` — 호출이 파라미터 리터럴보다 앞에서 시작한다. 리터럴이 그 인자 안에 있을 때만. */
      const back = Math.max(lo, anchor.start - 400);
      const post = /\$\.(?:post|get)\s*\([^;]*?,\s*(?:function\s*\(\s*([A-Za-z_$][\w$]*)?[^)]*\)\s*\{|([A-Za-z_$][\w$]*)\s*\))/g;
      post.lastIndex = 0;
      const window = clean.slice(back, Math.min(hi, anchor.start + 1500));
      for (let m = post.exec(window); m; m = post.exec(window)) {
        const start = back + (m.index ?? 0);
        const end = start + m[0].length;
        if (start <= anchor.start && anchor.start < end) { cb = [m[0], undefined, undefined, undefined, undefined, m[1], m[2]]; cbBase = start; cb.index = 0; break; }
      }
    }
    if (cb) {
      const named = cb[2] ?? cb[4] ?? cb[6];
      if (named) {
        callback = named;
        fn = functionBody(clean, named);
      } else {
        callback = "(inline)";
        const open = cbBase + (cb.index ?? 0) + cb[0].length - 1;
        fn = { param: cb[1] ?? cb[3] ?? cb[5] ?? "", start: open, end: matchingBrace(clean, open) };
      }
    } else {
      /* 자체 래퍼: `callAjax(url, pars, onResult)` — 마지막 인자가 이 파일의 함수면 콜백으로 본다. */
      const wrap = /\b[A-Za-z_$][\w$.]*\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(after);
      const candidate = wrap?.[1];
      const body = candidate ? functionBody(clean, candidate) : null;
      if (candidate && body) { callback = candidate; fn = body; }
    }
    calls.push({
      file: rel,
      line: at(anchor.start),
      function: owner ? (owner.name ?? owner.id.split(".").at(-1) ?? null) : null,
      function_id: owner ? owner.id : null,
      endpoint,
      params: anchor.params,
      callback,
      reads: fn ? callbackReads(clean, fn, at) : [],
    });
  }
  return calls;
}

/* ───────────────────────── 규칙 추론 · 해석 ───────────────────────── */

/**
 * @typedef {object} DispatchRule
 * @property {string} endpoint        `/TransData.do` (주소 끝 부분으로 맞춘다)
 * @property {string} bean_param      빈 이름을 실은 파라미터
 * @property {string} method_param    메서드를 실은 파라미터
 * @property {string} method_template `do{Action}` · `{action}`
 * @property {"config" | "inferred"} source
 * @property {number} [support]       추론 근거가 된 호출 수
 */

export const METHOD_TEMPLATES = ["do{Action}", "{action}", "{action}Action", "exec{Action}"];

/** @param {string} template @param {string} value */
export function methodName(template, value) {
  return template.replace("{Action}", capitalize(value)).replace("{action}", value);
}

/** 주소 끝 비교 — `/xu25/TransData.do` 와 `/TransData.do` 는 같은 디스패처다. */
export function sameEndpoint(/** @type {string | null} */ a, /** @type {string | null} */ b) {
  if (!a || !b) return false;
  const tail = (/** @type {string} */ s) => s.split("?")[0]?.replace(/\/+$/, "").split("/").at(-1)?.toLowerCase() ?? "";
  return tail(a) === tail(b);
}

/**
 * 호출 모양에서 규칙을 추론한다. 파라미터 하나의 값이 빈 이름이고, 다른 하나의 값으로 만든 메서드가
 * 그 빈 클래스에 실제로 있을 때만 — 추측이 아니라 양쪽 사실이 맞아야 규칙이 된다.
 * @param {DispatchCall[]} calls
 * @param {(beanId: string) => string | null} beanClass       빈 이름 → 클래스 id
 * @param {(classId: string, method: string) => boolean} hasMethod
 * @returns {DispatchRule[]}
 */
export function inferDispatchRules(calls, beanClass, hasMethod) {
  /** @type {Map<string, DispatchRule>} */
  const rules = new Map();
  for (const call of calls) {
    if (!call.endpoint) continue;
    const entries = Object.entries(call.params);
    for (const [bp, bv] of entries) {
      const cls = beanClass(bv);
      if (!cls) continue;
      for (const [mp, mv] of entries) {
        if (mp === bp) continue;
        const template = METHOD_TEMPLATES.find((t) => hasMethod(cls, methodName(t, mv)));
        if (!template) continue;
        const endpoint = `/${call.endpoint.split("/").at(-1)}`;
        const key = `${endpoint.toLowerCase()}|${bp}|${mp}|${template}`;
        const rule = rules.get(key) ?? { endpoint, bean_param: bp, method_param: mp, method_template: template, source: /** @type {const} */ ("inferred"), support: 0 };
        rule.support = (rule.support ?? 0) + 1;
        rules.set(key, rule);
      }
    }
  }
  return [...rules.values()];
}

/**
 * 호출 → (빈, 메서드 이름). 규칙에 맞는 첫 해석.
 * @param {DispatchCall} call
 * @param {DispatchRule[]} rules
 * @returns {{ rule: DispatchRule, bean: string, method: string } | null}
 */
export function resolveCall(call, rules) {
  for (const rule of rules) {
    if (!sameEndpoint(call.endpoint, rule.endpoint)) continue;
    const bean = call.params[rule.bean_param];
    const action = call.params[rule.method_param];
    if (bean && action) return { rule, bean, method: methodName(rule.method_template, action) };
  }
  return null;
}

/**
 * 위치 읽기가 컬럼 변경에 받는 영향. 컬럼 i 를 빼면 i 를 읽던 곳은 다른 값을, i 뒤를 읽던 곳은 한 칸 밀린 값을 읽는다.
 * @param {ResultRead} read
 * @param {number} removedIndex
 * @param {Array<{ index: number, name: string }>} columns
 * @returns {{ effect: "reads_removed" | "shifted" | "unaffected" | "unknown", now?: string, after?: string }}
 */
export function positionalEffect(read, removedIndex, columns) {
  if (read.col === null) return { effect: read.name ? "unaffected" : "unknown" };
  const now = columns[read.col]?.name;
  if (read.col < removedIndex) return { effect: "unaffected", ...(now ? { now } : {}) };
  const after = columns[read.col + 1]?.name ?? "(없음 — undefined)";
  return { effect: read.col === removedIndex ? "reads_removed" : "shifted", ...(now ? { now } : {}), after };
}
