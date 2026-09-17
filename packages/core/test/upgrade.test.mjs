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
import { compareVersions, installUrl, readVersion } from "../../cli/src/upgrade.mjs";

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

test("버전은 package.json 에서 온다 — 소스에 박으면 배포본과 갈라진다", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(readVersion(), manifest.version);
});
