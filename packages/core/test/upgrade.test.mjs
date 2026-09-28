/*
 * 판 올리기.
 *
 * 플러그인은 마켓플레이스가 갱신해 줬지만 npm 전역 설치는 아무도 안 알려 준다.
 * 여기서 지킬 것은 **틀린 비교로 엉뚱한 판을 권하지 않는 것**이다 — alpha.10 이
 * alpha.9 보다 낮다고 보면 사용자는 새 판을 영영 못 받는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareVersions, downloadCommand, failureReason, installArgs, installUrl, manualCommands, quoteForCmd, readVersion } from "../../cli/src/upgrade.mjs";

test("숫자로 비교한다 — 글자로 보면 alpha.10 이 alpha.9 보다 낮아진다", () => {
  assert.ok(compareVersions("v0.1.0-alpha.10", "v0.1.0-alpha.9") > 0);
  assert.ok(compareVersions("v0.1.0-alpha.2", "v0.1.0-alpha.10") < 0);
});

test("v 접두사가 있든 없든 같게 본다", () => {
  assert.equal(compareVersions("v0.1.0-alpha.5", "0.1.0-alpha.5"), 0);
});

test("자리별로 비교한다", () => {
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.1.2", "0.1.10") < 0);
});

test("정식판이 알파보다 뒤다 — 안 그러면 알파에서 못 벗어난다", () => {
  assert.ok(compareVersions("0.1.0", "0.1.0-alpha.9") > 0);
});

test("설치 주소는 tarball 이다 — git clone 경로는 사내망에서 막힌다", () => {
  const url = installUrl("v0.1.0-alpha.5");
  assert.match(url, /^https:\/\/codeload\.github\.com\//);
  assert.ok(!url.startsWith("github:"), "막히는 경로를 권하고 있다");
  assert.match(url, /refs\/tags\/v0\.1\.0-alpha\.5$/);
});

/*
 * 실측(2026-09-28): npm 12.0.2 PC 에서 URL 설치가 EALLOWREMOTE 로 거부됐다. 설정 파일 어디에도 없는
 * npm 12 의 새 기본값(allow-remote=none)이었다. 의도한 URL 설치이므로 명령 단위로 연다.
 */
test("upgrade 는 npm 12 의 URL 설치 차단을 명령 단위로 연다", () => {
  const args = installArgs("v0.1.0-alpha.30");
  assert.deepEqual(args.slice(0, 2), ["i", "-g"]);
  assert.ok(args.includes("--allow-remote=all"), "npm 12 에서 EALLOWREMOTE 로 막힌다");
  assert.equal(args.at(-1), installUrl("v0.1.0-alpha.30"));
});

/*
 * 실측(2026-09-28): 같은 PC 에서 PowerShell 은 codeload 에서 파일을 받았는데 npm 은
 * connect EACCES 로 거부됐다(보안 프로그램이 node.exe 의 외부 연결만 막음). 그래서 upgrade 는
 * 운영체제 도구로 먼저 받고 파일로 설치한다.
 */
test("내려받기는 node 가 아니라 운영체제 도구로 한다", () => {
  const url = installUrl("v0.1.0-alpha.32");
  const win = downloadCommand(url, "C:\\Temp\\a'b.tgz", "win32");
  assert.equal(win.cmd, "powershell.exe");
  const script = win.args.at(-1) ?? "";
  assert.match(script, /Invoke-WebRequest -Uri '/);
  assert.ok(script.includes("-OutFile 'C:\\Temp\\a''b.tgz'"), "작은따옴표를 PowerShell 규칙대로 넣지 않았다");
  assert.match(script, /ProgressPreference='SilentlyContinue'/, "진행 막대가 켜지면 5.1 에서 몇 배 느려진다");
  const nix = downloadCommand(url, "/tmp/a.tgz", "linux");
  assert.deepEqual([nix.cmd, nix.args.at(-1)], ["curl", url]);
});

test("내려받기 실패 사유는 첫 줄의 메시지다 — 오류 ID 가 아니라", () => {
  const ps = [
    "Invoke-WebRequest : 404: Not Found",
    "위치 줄:1 문자:1",
    "    + FullyQualifiedErrorId : WebCmdletWebResponseException",
  ].join("\r\n");
  assert.equal(failureReason(ps), "404: Not Found");
  assert.equal(failureReason("curl: (6) Could not resolve host: codeload.github.com"), "Could not resolve host: codeload.github.com");
  assert.equal(failureReason(""), "");
});

test("cmd 로 넘기는 인자는 공백이 있으면 따옴표로 감싼다 — DEP0190 경고 없이", () => {
  assert.equal(quoteForCmd("-g"), "-g");
  assert.equal(quoteForCmd("C:\\Users\\a\\axnavi.tgz"), "C:\\Users\\a\\axnavi.tgz");
  assert.equal(quoteForCmd("C:\\새 폴더\\a.tgz"), '"C:\\새 폴더\\a.tgz"');
});

test("자동으로 안 될 때 보여 주는 수동 명령은 내려받기 → 파일 설치 두 줄이다", () => {
  const lines = manualCommands("v0.1.0-alpha.32");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.includes(installUrl("v0.1.0-alpha.32")));
  assert.match(lines[1] ?? "", /^npm i -g /);
});

test("버전은 package.json 에서 온다 — 소스에 박으면 배포본과 갈라진다", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(readVersion(), manifest.version);
});
