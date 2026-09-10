import html
import re
from urllib.parse import urlsplit

# 정적 빌드(wiki_generator.py)가 쓰는 최소 HTML 렌더러.
# render_markdown_page()는 외부 CDN 의존 없이 기본 Markdown을 안전한 HTML로 표시한다 —
# 폐쇄망 환경에서도, file:// 로 직접 열어도 동작해야 하기 때문. (_html/ 정적 렌더 사본에서 사용)
# render_index()는 [2026-07-15]부터 Docsify 기반이라 예외 — 외부 CDN 필요, file://는 미지원(serve.bat으로 로컬 서버 실행 필요).
# 별도 프로젝트 wiki-hub(중앙 허브)는 이 파일과 무관 — 자체 렌더러(CDN 미사용)를 갖는다.

PAGE_STYLE = """
body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
pre { white-space: pre-wrap; word-break: break-word; background: #f6f8fa; padding: 16px; border-radius: 6px; }
a { color: #1a5fa8; }
.nav { margin-bottom: 16px; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; overflow-wrap: anywhere; }
blockquote { border-left: 3px solid #aaa; margin-left: 0; padding-left: 14px; color: #555; }
code { overflow-wrap: anywhere; }
"""

INDEX_STYLE = """
body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 700px; margin: 40px auto; }
li { margin: 6px 0; }
h3 { margin-top: 32px; color: #666; }
"""


def _inline(text):
    parts, position = [], 0
    pattern = r"`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*"
    for match in re.finditer(pattern, text):
        parts.append(html.escape(text[position:match.start()]))
        code, label, target, bold = match.groups()
        try:
            scheme = urlsplit(target).scheme.lower() if target is not None else ""
        except ValueError:
            scheme = "invalid"
        if code is not None:
            parts.append(f"<code>{html.escape(code)}</code>")
        elif bold is not None:
            parts.append(f"<strong>{html.escape(bold)}</strong>")
        elif scheme in ("", "http", "https", "mailto") and not target.startswith(("//", "\\\\")):
            if not scheme:
                target = re.sub(r"\.md(?=#|$)", ".html", target)
                if target.startswith("call-graph.html"):
                    target = "../" + target
            parts.append(f'<a href="{html.escape(target, quote=True)}">{html.escape(label)}</a>')
        else:
            parts.append(html.escape(label or ""))
        position = match.end()
    parts.append(html.escape(text[position:]))
    return "".join(parts)


def render_markdown(content):
    """헤딩·표·목록·인용·코드·링크 지원. 원본 HTML은 실행하지 않는다."""
    lines = content.splitlines()
    blocks, i = [], 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            blocks.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
        elif re.match(r"^#{1,6} ", line):
            heading, text = line.split(" ", 1)
            anchor = re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")
            blocks.append(f'<h{len(heading)} id="{html.escape(anchor)}">{_inline(text)}</h{len(heading)}>')
        elif i + 1 < len(lines) and "|" in line and re.fullmatch(r"[\s|:\-]+", lines[i + 1]) and "-" in lines[i + 1]:
            row = lambda text, tag: "<tr>" + "".join(f"<{tag}>{_inline(c.strip())}</{tag}>" for c in text.strip().strip("|").split("|")) + "</tr>"
            table = ["<table><thead>", row(line, "th"), "</thead><tbody>"]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                table.append(row(lines[i], "td"))
                i += 1
            blocks.append("".join(table) + "</tbody></table>")
            continue
        elif re.match(r"^\s*(?:[-*] |\d+\. )", line):
            items = []
            ordered = bool(re.match(r"^\s*\d+\. ", line))
            item_pattern = r"^\s*\d+\. " if ordered else r"^\s*[-*] "
            while i < len(lines) and re.match(item_pattern, lines[i]):
                items.append("<li>" + _inline(re.sub(r"^\s*(?:[-*] |\d+\. )", "", lines[i])) + "</li>")
                i += 1
            tag = "ol" if ordered else "ul"
            blocks.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
            continue
        elif line.startswith("> "):
            blocks.append("<blockquote>" + _inline(line[2:]) + "</blockquote>")
        elif line.strip() == "---":
            blocks.append("<hr>")
        elif line.strip():
            blocks.append("<p>" + _inline(line) + "</p>")
        i += 1
    return "\n".join(blocks)


def render_markdown_page(title, page_path, content, index_href="index.html"):
    """기본 Markdown을 오프라인에서도 표·링크·목록으로 읽을 수 있게 렌더한다."""
    rendered = render_markdown(content)
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>{html.escape(page_path)} - {html.escape(title)}</title>
<style>{PAGE_STYLE}</style></head>
<body>
<div class="nav"><a href="{html.escape(index_href)}">← 전체 페이지 목록</a></div>
<h2>{html.escape(page_path)}</h2>
{rendered}
</body></html>"""


def render_static_index(project_name, entries):
    """file://로 직접 열어도 동작하는 정적 홈 페이지. CDN/서버 불필요 —
    entries의 href는 wiki_dir 기준 상대경로(예: _html/Home.html, call-graph.html)여야 한다."""
    items = "\n".join(
        f'<li><a href="{html.escape(href)}">{html.escape(label)}</a></li>'
        for href, label, _source in entries
    )
    safe = html.escape(project_name)
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>{safe} Wiki (오프라인)</title>
<style>{INDEX_STYLE}</style></head>
<body>
<h2>{safe} Wiki</h2>
<p>file://로 직접 연 오프라인 보기. 서버 실행형(검색·사이드바 포함)은 <code>serve.bat</code> 실행 후 <a href="index.html">index.html</a> 참고.</p>
<ul>
{items}
</ul>
</body></html>"""


def render_index(title, heading="", entries=None, extra_html="", **kwargs):
    """Docsify 4 기반 index.html 생성.
    [2026-07-15] 토큰 절감 리팩토링으로 단순 정적 HTML로 교체됐던 것을 Docsify로 복원.
    향후 이 함수를 단순 정적 HTML로 되돌리지 말 것 — _sidebar.md/_navbar.md가 짝으로 필요.
    title 인자를 project_name으로 사용. heading/entries/extra_html 무시 (Docsify가 처리).
    """
    project_name = title
    safe = html.escape(project_name)
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>{safe}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.8/dist/web/static/pretendard.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify-themeable@0/dist/css/theme-simple.css">
  <style>
    :root {{
      --theme-color: #2563eb;
      --base-font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --base-font-size: 15px;
      --sidebar-width: 280px;
      --content-max-width: 960px;
      --heading-font-weight: 700;
      --sidebar-background: #0f172a;
      --sidebar-name-color: #ffffff;
      --sidebar-nav-link-color: #cbd5e1;
      --sidebar-nav-link-color--active: #38bdf8;
      --sidebar-nav-link-color--hover: #ffffff;
      --base-line-height: 1.7;
      --heading-h1-color: #0f172a;
      --heading-h2-color: #1e293b;
      --heading-h3-color: #334155;
      --blockquote-border-color: #3b82f6;
      --blockquote-background: #eff6ff;
    }}
    .sidebar-nav > ul > li > p {{
      font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.6px; color: #64748b;
      margin: 16px 0 4px 12px;
    }}
    table {{ border-collapse: separate; border-spacing: 0; border-radius: 8px; overflow: hidden; }}
    th {{ background: #f8fafc; }}
    td, th {{ padding: 10px 14px; }}
    blockquote {{ border-radius: 0 8px 8px 0; }}
  </style>
</head>
<body>
  <div id="app">로딩 중...</div>
  <script>
    window.$docsify = {{
      name: '📋 {safe}',
      repo: '',
      homepage: 'Home.md',
      loadSidebar: true,
      loadNavbar: true,
      subMaxLevel: 3,
      auto2top: true,
      executeScript: false,
      search: {{
        maxAge: 86400000,
        paths: 'auto',
        placeholder: '문서 검색...',
        noData: '검색 결과가 없습니다.',
        depth: 6,
        hideOtherSidebarContent: false
      }},
      pagination: {{
        previousText: '← 이전',
        nextText: '다음 →',
        crossChapter: true,
      }},
      copyCode: {{
        buttonText: '복사',
        errorText: '오류',
        successText: '복사됨 ✓'
      }},
      themeColor: '#2563eb',
      markdown: {{
        renderer: {{
          code: function(code, lang) {{
            if (lang === 'mermaid') {{
              var esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              return '<pre class="mermaid">' + esc + '</pre>';
            }}
            return this.origin.code.apply(this, arguments);
          }}
        }}
      }},
      plugins: [
        function(hook) {{
          hook.doneEach(function() {{
            if (window.mermaid && document.querySelector('.mermaid')) {{
              window.mermaid.initialize({{ startOnLoad: false, securityLevel: 'strict' }});
              window.mermaid.run({{ querySelector: '.mermaid' }});
            }}
          }});
        }}
      ],
    }}
  </script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4/lib/docsify.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4/lib/plugins/search.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify-copy-code@2/dist/docsify-copy-code.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify-pagination/dist/docsify-pagination.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-sql.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-json.min.js"></script>
</body>
</html>"""
