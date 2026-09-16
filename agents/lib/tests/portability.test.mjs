import { readFileSync, readdirSync, statSync } from "node:fs";
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
}
