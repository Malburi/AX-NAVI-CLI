# docs/site의 Docsify 문서를 폐쇄망용 단일 HTML 파일로 묶는 빌더 (LLM 없음, CDN 없음)
"""
Docsify 사이트(docs/site/index.html)는 CDN이 필요하다. 폐쇄망이나 파일 공유로 배포할 때는
이 스크립트가 `_sidebar.md` 순서대로 모든 페이지를 읽어 한 파일로 묶는다.

    python agents/lib/site_build.py --out docs/site/dist/ax-navi-docs.html

마크다운 렌더러는 wiki_render.render_markdown(위키 오프라인 사본과 같은 것)을 그대로 쓴다.
사이트 내부 링크(`/skills/safe-modify.md`)는 페이지 앵커(`#skills/safe-modify`)로 바꾼다.
mermaid 코드 블록은 라이브러리 없이 렌더할 수 없으므로 코드 그대로 보이고 안내 문구를 붙인다.
"""

import argparse
import html
import os
import re
import sys

LIB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LIB_DIR)
import wiki_render  # noqa: E402

SITE_DIR = os.path.normpath(os.path.join(LIB_DIR, "..", "..", "docs", "site"))
SIDEBAR_LINK_RE = re.compile(r"^(\s*)- \[([^\]]+)\]\(([^)]+)\)\s*$")
SIDEBAR_GROUP_RE = re.compile(r"^- \*\*([^*]+)\*\*\s*$")
MD_LINK_RE = re.compile(r"\]\((/[^)#\s]+?)\.md(#[^)\s]*)?\)")
ROOT_LINK_RE = re.compile(r"\]\(/\)")
MERMAID_RE = re.compile(r"```mermaid\n(.*?)```", re.S)
HTML_BLOCK_RE = re.compile(r"<div class=\"home-grid\">.*?</div>\s*\n", re.S)


def parse_sidebar(text):
    """[(group, [(label, page_path)])] — page_path는 'skills/safe-modify' 같은 확장자 없는 경로."""
    groups = []
    for raw in text.splitlines():
        m = SIDEBAR_GROUP_RE.match(raw.strip())
        if m:
            groups.append((m.group(1).strip(), []))
            continue
        m = SIDEBAR_LINK_RE.match(raw)
        if not m or not groups:
            continue
        label, href = m.group(2), m.group(3)
        page = "README" if href in ("/", "/README.md") else href.strip("/")
        if page.endswith(".md"):
            page = page[:-3]
        groups[-1][1].append((label, page))
    return groups


def page_id(page):
    return page.replace("/", "-").lower()


def rewrite_links(md):
    md = ROOT_LINK_RE.sub("](#readme)", md)
    return MD_LINK_RE.sub(lambda m: f"](#{page_id(m.group(1).strip('/'))})", md)


def strip_site_only_html(md):
    """홈의 카드 그리드는 Docsify 전용 HTML이다. 오프라인 사본에서는 링크 목록으로 바꾼다."""
    def to_list(m):
        cards = re.findall(r'href="#/([^"]+)".*?<strong>(.*?)</strong>\s*<span class="desc">(.*?)</span>', m.group(0), re.S)
        lines = [f"- [{html.unescape(t)}](#{page_id(h)}) — {html.unescape(d)}" for h, t, d in cards]
        return "\n".join(lines) + "\n\n"
    return HTML_BLOCK_RE.sub(to_list, md)


def render_page(md):
    md = strip_site_only_html(rewrite_links(md))
    md = MERMAID_RE.sub(lambda m: "```text\n" + m.group(1) + "```\n\n> 위 블록은 Mermaid 마크업이다. GitHub나 Mermaid를 지원하는 편집기에 붙이면 그림으로 보인다.\n", md)
    return wiki_render.render_markdown(md)


STYLE = """
:root{--ground:#F6F7F4;--surface:#FFFFFF;--surface-2:#EEF1EE;--ink:#1B2530;--ink-soft:#46535E;--muted:#6B7882;--line:#D8DEDB;--accent:#0F7B85;--accent-ink:#0A5C64;--accent-soft:#E1F0F1;--code-bg:#F0F3F1;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ground:#0E1418;--surface:#151D23;--surface-2:#1B252C;--ink:#E3E9EC;--ink-soft:#B9C4CB;--muted:#8E9CA6;--line:#26323A;--accent:#48B7BF;--accent-ink:#7ACFD5;--accent-soft:#123338;--code-bg:#10181D;}}
:root[data-theme="dark"]{--ground:#0E1418;--surface:#151D23;--surface-2:#1B252C;--ink:#E3E9EC;--ink-soft:#B9C4CB;--muted:#8E9CA6;--line:#26323A;--accent:#48B7BF;--accent-ink:#7ACFD5;--accent-soft:#123338;--code-bg:#10181D;}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:"Noto Sans KR","Malgun Gothic",-apple-system,"Segoe UI",sans-serif;line-height:1.7;word-break:keep-all}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
nav{position:fixed;top:0;bottom:0;left:0;width:288px;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line);padding:0 0 40px}
nav h1{margin:0;padding:22px 22px 14px;font-size:1.05rem;font-weight:800;letter-spacing:-.01em;border-bottom:1px solid var(--line)}
nav h1 a{color:var(--ink)}nav p{margin:14px 0 4px;padding:0 22px;font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
nav ul{list-style:none;margin:0;padding:0 12px}nav li a{display:block;padding:5px 10px;border-radius:5px;color:var(--ink-soft);font-size:.92rem;border-left:2px solid transparent}
nav li a:hover{background:var(--surface-2);color:var(--ink);text-decoration:none}nav li a.active{color:var(--accent-ink);background:var(--accent-soft);border-left-color:var(--accent);font-weight:500}
main{padding-left:288px}section{display:none;max-width:74ch;margin:0 auto;padding:56px 40px 96px}section.active{display:block}
section h1,section h2,section h3,section h4{font-weight:800;letter-spacing:-.015em;line-height:1.3;text-wrap:balance}
section h1{font-size:2rem;margin:0 0 .6em}section h1+p{font-size:1.08rem;color:var(--ink-soft)}section h2{font-size:1.35rem;margin:2.2em 0 .7em;padding-top:.6em;border-top:1px solid var(--line)}section h3{font-size:1.08rem;margin:1.8em 0 .5em}
section p,section ul,section ol{margin:0 0 1em}section li{margin:.25em 0}
section blockquote{margin:1.2em 0;padding:.7em 1em;border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--ink-soft);border-radius:0 6px 6px 0}section blockquote p{margin:0}
section code{font-family:"JetBrains Mono","D2Coding",Consolas,monospace;font-size:.86em;background:var(--code-bg);padding:.12em .38em;border-radius:4px}
section pre{margin:1.2em 0;padding:14px 16px;background:var(--code-bg);border:1px solid var(--line);border-radius:8px;overflow-x:auto;line-height:1.55}section pre code{background:none;padding:0;font-size:.84rem;white-space:pre}
section table{border-collapse:collapse;width:100%;font-size:.92rem;font-variant-numeric:tabular-nums;display:block;overflow-x:auto}
section th,section td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}section th{font-weight:700;color:var(--ink-soft);font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;background:var(--surface-2)}
.toggle{position:fixed;left:0;bottom:0;width:44px;height:44px;border:0;border-top:1px solid var(--line);border-right:1px solid var(--line);background:var(--surface);cursor:pointer}
.toggle span{display:block;width:18px;height:2px;margin:4px auto;background:var(--ink-soft)}
body.close nav{display:none}body.close main{padding-left:0}
@media (max-width:860px){nav{display:none}main{padding-left:0}body.close nav{display:block}section{padding:40px 20px 80px}}
"""

SCRIPT = """
(function(){
  var sections = document.querySelectorAll('main > section');
  var links = document.querySelectorAll('nav a[data-page]');
  function show(id){
    var found = false;
    sections.forEach(function(s){ var on = s.id === id; s.classList.toggle('active', on); if (on) found = true; });
    if (!found) { sections[0].classList.add('active'); id = sections[0].id; }
    links.forEach(function(a){ a.classList.toggle('active', a.getAttribute('data-page') === id); });
    document.title = (document.querySelector('#' + id + ' h1') || {}).textContent || 'AX Navi 문서';
    window.scrollTo(0, 0);
  }
  function route(){ show((location.hash || '#readme').slice(1).split('?')[0]); }
  window.addEventListener('hashchange', route);
  document.querySelector('.toggle').addEventListener('click', function(){ document.body.classList.toggle('close'); });
  route();
})();
"""


def build(site_dir=SITE_DIR):
    sidebar = parse_sidebar(open(os.path.join(site_dir, "_sidebar.md"), encoding="utf-8-sig").read())
    nav, body, missing = [], [], []
    for group, items in sidebar:
        nav.append(f"<p>{html.escape(group)}</p><ul>")
        for label, page in items:
            path = os.path.join(site_dir, *page.split("/")) + ".md"
            pid = page_id(page)
            nav.append(f'<li><a href="#{pid}" data-page="{pid}">{html.escape(label)}</a></li>')
            if not os.path.isfile(path):
                missing.append(page + ".md")
                body.append(f'<section id="{pid}"><h1>{html.escape(label)}</h1><p>이 페이지는 아직 작성되지 않았다.</p></section>')
                continue
            md = open(path, encoding="utf-8-sig").read()
            body.append(f'<section id="{pid}">{render_page(md)}</section>')
        nav.append("</ul>")
    doc = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>AX Navi 문서</title><style>{STYLE}</style></head>
<body><nav><h1><a href="#readme">AX Navi 문서</a></h1>{''.join(nav)}</nav>
<main>{''.join(body)}</main>
<button class="toggle" aria-label="메뉴 열기/닫기"><span></span><span></span><span></span></button>
<script>{SCRIPT}</script></body></html>"""
    return doc, missing


def main():
    parser = argparse.ArgumentParser(description="docs/site를 단일 HTML로 묶는다 (폐쇄망 배포용)")
    parser.add_argument("--site", default=SITE_DIR, help="docs/site 경로")
    parser.add_argument("--out", required=True, help="출력 HTML 경로")
    args = parser.parse_args()
    doc, missing = build(args.site)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"생성: {args.out} ({len(doc.encode('utf-8')) // 1024}KB)")
    if missing:
        print("WARN 누락 페이지: " + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
