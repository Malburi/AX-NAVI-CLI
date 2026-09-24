import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonBin } from "../python-bin.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".mjs") || entry.endsWith(".js")) out.push(path);
  }
  return out;
}

export async function test(register, assert) {
  register("파이썬 인터프리터 이름을 코드에 하드코딩하지 않는다", () => {
    /*
     * 예전에는 테스트가 "python3", 런타임 문서가 "python"을 각각 하드코딩해
     * 윈도우에서는 테스트 5건이, 리눅스에서는 런타임 스크립트가 실패했다.
     * 이름은 반드시 pythonBin()으로 결정한다.
     */
    const offenders = [];
    /*
     * packages/ 까지 본다. 한때 agents/lib 만 봤고, 그래서 CLI 가 자기 사본을 들고 있는
     * 것을 못 잡았다 — 그 사본에는 Store 별칭 방어가 없어서 회사 PC 에서 doctor 가
     * 출력 한 줄 없이 죽었다. 검사 범위가 좁으면 규칙이 있어도 새 코드가 빠져나간다.
     */
    for (const root of [join(ROOT, "agents", "lib"), join(ROOT, "packages")]) {
      for (const file of walk(root)) {
        if (file.endsWith("python-bin.mjs")) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/execFileSync\(\s*"(python3?)"|spawnSync\(\s*"(python3?)"/g)) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${match[1] || match[2]}`);
        }
      }
    }
    assert.equal(offenders.length, 0, `하드코딩된 인터프리터: ${JSON.stringify(offenders)}`);
  });

  register("0바이트 Store 별칭은 실행해 보지 않고 건너뛴다", () => {
    /*
     * 실행하면 job object 안에서 **그 다음 spawn 이** libuv 수준 abort 로 죽는다
     * (AssignProcessToJobObject: (87), 네이티브라 try/catch 불가).
     * 그래서 후보를 spawn 하기 전에 크기 0 인지 본다. 이 방어가 빠지면 EDR 이 도는
     * 사내 PC 에서 axnavi doctor 가 통째로 죽는다 — 실측으로 그랬다.
     */
    const text = readFileSync(join(ROOT, "agents", "lib", "python-bin.mjs"), "utf8");
    assert.ok(/statSync\(/.test(text), "별칭 판별에 파일 크기 검사가 없다");
    const guardAt = text.indexOf("isStoreAlias(name)) continue");
    const spawnAt = text.indexOf('spawnSync(name, ["--version"]');
    assert.ok(guardAt > 0 && spawnAt > 0, "후보 루프 구조가 바뀌었다");
    assert.ok(guardAt < spawnAt, "spawn 뒤에 걸러낸다 — 그러면 이미 늦다");
  });

  register("pythonBin은 실제로 실행되는 인터프리터만 인정한다", () => {
    const bin = pythonBin();
    /* 이 환경에는 파이썬이 있으므로 이름이 나와야 한다. 없는 환경이면 null이 정상이다. */
    assert.ok(bin === null || ["python3", "python", "py"].includes(bin), `예상 밖 값: ${bin}`);
    if (bin) {
      /* 두 번째 호출은 캐시에서 같은 값이 나와야 한다(매 호출마다 프로세스를 띄우지 않는다). */
      assert.equal(pythonBin(), bin, "결과가 캐시돼야 함");
    }
  });

  register("스택 사전 점검은 벤더·점 폴더의 파일을 스택 근거로 쓰지 않는다", () => {
    const bin = pythonBin();
    if (!bin) return; // 파이썬이 없는 환경 — python-bin 테스트가 사유를 남긴다
    /* 실측: fck_editor/editor/filemanager/connectors/py/*.py 12개만으로 jQuery/HTML 저장소를 python_web으로 판정했다. */
    const root = mkdtempSync(join(tmpdir(), "ax-precheck-"));
    try {
      const put = (rel, text) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
      put("html/fck_editor/editor/filemanager/connectors/py/connector.py", "import os\n");
      put(".settings/tool.py", "x = 1\n");
      put("html/script/js/forms.js", "function Forms() {}\n");
      execFileSync(bin, [join(ROOT, "agents", "lib", "stack_precheck.py"), "--root", root], { encoding: "utf8" });
      const result = JSON.parse(readFileSync(join(root, "_workspace", "00_stack_precheck.json"), "utf8"));
      assert.equal(result.extractors.length, 0, JSON.stringify(result.extractors));
      put("app/service.py", "def run():\n    return 1\n");
      execFileSync(bin, [join(ROOT, "agents", "lib", "stack_precheck.py"), "--root", root], { encoding: "utf8" });
      const again = JSON.parse(readFileSync(join(root, "_workspace", "00_stack_precheck.json"), "utf8"));
      assert.equal(again.extractors[0]?.stack, "python_web", "우리 코드의 .py는 그대로 근거다");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  register("스킬·에이전트 본문은 호스트가 치환하는 ${CLAUDE_PLUGIN_ROOT} 표기만 쓴다", () => {
    /*
     * 실측. Claude Code 는 SKILL.md·agents/*.md 본문의 `${CLAUDE_PLUGIN_ROOT}` 만 절대경로로
     * 바꾸고 `$CLAUDE_PLUGIN_ROOT`·`$env:CLAUDE_PLUGIN_ROOT` 는 그대로 둔다. 플러그인 모드
     * Bash 에는 그 환경변수도 없다. 그래서 `"$env:CLAUDE_PLUGIN_ROOT/agents/lib/x"` 는 bash 에서
     * `":CLAUDE_PLUGIN_ROOT/agents/lib/x"` 가 됐고, 서브에이전트가 `find /` 로 디스크를 뒤지다
     * 다른 플러그인 캐시의 같은 이름 스크립트를 실행했다.
     */
    const offenders = [];
    const bodies = [
      ...readdirSync(join(ROOT, "skills")).map((d) => join(ROOT, "skills", d, "SKILL.md")),
      ...readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).map((f) => join(ROOT, "agents", f)),
    ];
    for (const file of bodies) {
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      if (/\$env:CLAUDE_PLUGIN_ROOT|\$\{env:CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/.test(text)) offenders.push(file.slice(ROOT.length + 1));
    }
    /* 블록 파일은 Read 로 읽혀 치환이 없다. pipeline-runner 가 [plugin_root] 를 채운다. */
    const blocks = join(ROOT, "agents", "lib", "pipeline-runner");
    for (const f of readdirSync(blocks).filter((f) => f.endsWith(".md"))) {
      if (/CLAUDE_PLUGIN_ROOT/.test(readFileSync(join(blocks, f), "utf8"))) offenders.push(`agents/lib/pipeline-runner/${f}`);
    }
    assert.equal(offenders.join(", "), "", "치환되지 않는 플러그인 루트 표기");
  });
}
