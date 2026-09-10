import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pythonBin } from "../python-bin.mjs";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const site = join(plugin, "docs", "site");

function walkMd(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== "dist") walkMd(full, out); continue; }
    if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

export async function test(register, assert) {
  register("문서 사이트의 사이드바 항목과 페이지 간 링크가 전부 실제 파일을 가리킨다", () => {
    const sidebar = readFileSync(join(site, "_sidebar.md"), "utf8");
    const sidebarLinks = [...sidebar.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(sidebarLinks.length > 60, `사이드바 항목 수: ${sidebarLinks.length}`);
    const missingSidebar = sidebarLinks
      .filter((href) => href !== "/")
      .filter((href) => !existsSync(join(site, href.replace(/^\//, ""))));
    assert.equal(missingSidebar.length, 0, `사이드바 누락 페이지: ${missingSidebar.join(", ")}`);

    const broken = [];
    for (const file of walkMd(site)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\]\((\/[^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
        if (!existsSync(join(site, m[1].replace(/^\//, "")))) broken.push(`${file.slice(site.length + 1)} → ${m[1]}`);
      }
      assert.ok(!/^---\s*\n[\s\S]*?\n---/m.test(text.slice(0, 200)), `${file}: 문서 페이지에 frontmatter 금지`);
    }
    assert.equal(broken.length, 0, `깨진 내부 링크 ${broken.length}건: ${broken.slice(0, 8).join(" | ")}`);
  });

  register("오프라인 단일 파일 빌더가 모든 사이드바 페이지를 한 HTML로 묶는다", () => {
    const out = mkdtempSync(join(tmpdir(), "ax-site-"));
    try {
      const result = spawnSync(pythonBin(), [join(plugin, "agents/lib/site_build.py"), "--out", join(out, "docs.html")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const html = readFileSync(join(out, "docs.html"), "utf8");
      assert.ok(html.includes('<section id="readme">'));
      assert.ok(html.includes('<section id="skills-safe-modify">'));
      assert.ok(!html.includes("cdn.jsdelivr.net"), "오프라인 사본은 CDN을 참조하지 않는다");
      assert.ok(!html.includes("](/skills/"), "내부 링크가 앵커로 치환됨");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
