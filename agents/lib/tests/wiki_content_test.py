# 위키 업무 설명·분석 범위·오프라인 렌더링·리포트 조립의 회귀 검증.
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wiki_content
import wiki_render
from analyzer_index_summary import assemble_report


class WikiContentTest(unittest.TestCase):
    def test_business_sections_preferred_over_build_instructions(self):
        report = "## 업무 개요\n주문 취소\n\n## 업무 규칙\n승인 후 취소 금지\n\n## A. 빌드 / 실행 명령\nnpm install\n"
        rendered = wiki_content.build_domain_overview(report)
        self.assertIn("승인 후 취소 금지", rendered)
        self.assertNotIn("npm install", rendered)

    def test_missing_data_is_not_complete(self):
        coverage = wiki_content.flow_coverage({"endpoints": [{"id": "missing"}]}, None)
        self.assertEqual(coverage["status"], "PARTIAL")
        self.assertEqual(coverage["missing_flow"], ["missing"])
        self.assertIn("흐름 미연결", wiki_content.build_flow_coverage(coverage))

    def test_branching_is_shown_as_edges(self):
        flow = {"chains": [{"endpoint_id": "e", "call_edges": [{"from": "A", "to": "B"}, {"from": "A", "to": "C"}], "method_chain": ["A", "B", "C"], "truncated": True}]}
        rendered = wiki_content.build_business_flows({"endpoints": [{"id": "e", "path": "/e"}]}, flow)
        self.assertIn("`A` | `B`", rendered)
        self.assertIn("`A` | `C`", rendered)
        self.assertNotIn("`B` | `C`", rendered)
        self.assertIn("상한", rendered)

    def test_safe_offline_markdown(self):
        rendered = wiki_render.render_markdown_page("wiki", "flow.md", "# Flow\n\n| From | To |\n|---|---|\n| A | B |\n\n[Domain](domain.md)\n[unsafe](javascript:alert)\n<script>alert(1)</script>\n```js\nconst x = '<tag>';\n```")
        self.assertIn("<table>", rendered)
        self.assertIn('href="domain.html"', rendered)
        self.assertNotIn('href="javascript:', rendered)
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("<pre><code>", rendered)
        self.assertNotIn("href=", wiki_render.render_markdown("[broken](http://[bad)"))
        self.assertIn("<ol>", wiki_render.render_markdown("1. First\n2. Second"))

    def test_partner_endpoint_ids_do_not_overwrite_own_flow(self):
        pages = wiki_content.build_flow_pages([
            {"label": "own", "contract_json": {"endpoints": [{"id": "same", "description": "own API"}]},
             "flow_json": {"chains": [{"endpoint_id": "same", "note": "own rule"}]}},
            {"label": "partner", "contract_json": {"endpoints": [{"id": "same"}]}}
        ])
        self.assertIn("own rule", pages[0])
        self.assertIn("partner", pages[1])
        self.assertEqual(pages[2]["endpoints"], 2)
        self.assertEqual(pages[2]["with_flow"], 1)
        self.assertEqual(pages[2]["missing_flow"], ["partner::same"])
        self.assertEqual(pages[2]["status"], "PARTIAL")

    def test_summary_is_replaced_without_touching_narrative(self):
        report = "## 업무 개요\n업무 해석\n[SECTION_B_INDEX_SUMMARY_INSERT]\n## 분석 미확인\n미확인 규칙\n"
        first = assemble_report(report, "기계 요약 1")
        second = assemble_report(first, "기계 요약 2")
        self.assertNotIn("기계 요약 1", second)
        self.assertIn("기계 요약 2", second)
        self.assertIn("업무 해석", second)
        self.assertEqual(assemble_report(second, "기계 요약 2"), second)
        self.assertEqual(assemble_report("구형 리포트", "요약"), "구형 리포트")


if __name__ == "__main__":
    unittest.main()
