import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBudget, claimBudget, budgetStatus, recordSpend, estimateCost } from "../ai-budget.mjs";

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "ax-budget-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function test(register, assert) {
  register("ai-budget init은 동일 session 재호출 시 멱등하다", () => {
    withTempRoot((root) => {
      const first = initBudget({ root, session: "s1", initial: 3, retries: 2 });
      const second = initBudget({ root, session: "s1", initial: 99, retries: 99 });
      assert.equal(second.limits.initial, 3, "재init이 기존 한도를 덮어쓰면 안 됨");
      assert.equal(first.used.initial, 0);
    });
  });

  register("initial claim은 role마다 정확히 1회 허용된다", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2 });
      const claim = claimBudget({ root, session: "s1", role: "analyzer", kind: "initial" });
      assert.equal(claim.allowed, true);
      assert.equal(budgetStatus(root).used.initial, 1);

      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "analyzer", kind: "initial" });
      } catch (e) {
        threw = true;
        assert.ok(/한 번만 허용/.test(e.message), `동일 role 재claim 오류 메시지: ${e.message}`);
      }
      assert.ok(threw, "동일 role의 두 번째 initial claim은 거부돼야 함");
    });
  });

  register("initial 예산은 role 3개(analyzer/writer/pattern-extractor)까지만 허용된다", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2 });
      claimBudget({ root, session: "s1", role: "analyzer", kind: "initial" });
      claimBudget({ root, session: "s1", role: "writer", kind: "initial" });
      claimBudget({ root, session: "s1", role: "pattern-extractor", kind: "initial" });
      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "extra-role", kind: "initial" });
      } catch (e) {
        threw = true;
        assert.ok(/예산 초과/.test(e.message), `예산 초과 메시지: ${e.message}`);
      }
      assert.ok(threw, "initial 예산 소진 후 새 role claim은 거부돼야 함");
    });
  });

  register("retry claim은 --reason 없이 거부된다", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2 });
      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "analyzer", kind: "retry", reason: "" });
      } catch (e) {
        threw = true;
        assert.ok(/reason이 필요/.test(e.message));
      }
      assert.ok(threw, "reason 없는 retry claim은 거부돼야 함");
    });
  });

  register("retry 예산은 2회까지 허용되고 초과 시 거부된다", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2 });
      claimBudget({ root, session: "s1", role: "analyzer", kind: "retry", reason: "T-A-RETRY test" });
      claimBudget({ root, session: "s1", role: "writer", kind: "retry", reason: "T-W-RETRY test" });
      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "writer", kind: "retry", reason: "third retry" });
      } catch (e) {
        threw = true;
        assert.ok(/retries AI 호출 예산 초과: 2\/2/.test(e.message), `예산 초과 메시지: ${e.message}`);
      }
      assert.ok(threw, "retries 예산 소진 후 세 번째 claim은 거부돼야 함");
    });
  });

  /*
   * 예전에는 시간 한도가 하드 스톱이었다. 벽시계로 재는 값이라 뺐다.
   *
   * 실측 사고: 페어 초기화가 analyzer 를 다 끝내고 writer 앞에서 거부됐다
   * ("시간 예산 초과: 199.1분 / 54분"). 그 199분의 대부분은 대화가 끊겼다 재개되기까지의
   * 공백이었다. 세션이 아무것도 안 하는 동안 예산이 줄어든 것이다 — 소비를 막지 못하면서
   * 다 끝낸 작업을 못 쓰게 만든다. 재개를 전제로 하는 실행 경로에서는 규칙이 거꾸로 선다.
   */
  register("시간이 지나도 claim을 막지 않는다 — 벽시계는 소비의 척도가 아니다", () => {
    withTempRoot((root) => {
      const t0 = 1_000_000;
      initBudget({ root, session: "s1", initial: 3, retries: 2, minutes: 30, now: t0 });
      assert.equal(claimBudget({ root, session: "s1", role: "analyzer", now: t0 }).allowed, true);
      // 한도(30분)를 훌쩍 넘긴 시각. 예전에는 여기서 거부됐다.
      const late = claimBudget({ root, session: "s1", role: "writer", now: t0 + 199 * 60_000 });
      assert.equal(late.allowed, true, "경과 시간으로 진행을 막으면 안 된다");
    });
  });

  register("토큰 한도는 그대로 막는다 — 소비의 상한은 이쪽이 잰다", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2, tokens: 1000 });
      claimBudget({ root, session: "s1", role: "analyzer" });
      recordSpend({ root, role: "analyzer", spentTokens: 1200 });
      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "writer" });
      } catch (e) {
        threw = true;
        assert.ok(/토큰 예산 초과/.test(e.message), `토큰 예산 메시지: ${e.message}`);
      }
      assert.ok(threw, "토큰 한도를 넘겼으면 거부돼야 한다");
    });
  });

  register("경과 시간은 계속 보고한다 — 막지 않는 것과 안 알리는 것은 다르다", () => {
    withTempRoot((root) => {
      const t0 = 1_000_000;
      initBudget({ root, session: "s1", initial: 3, retries: 2, minutes: 30, now: t0 });
      const claim = claimBudget({ root, session: "s1", role: "analyzer", now: t0 + 40 * 60_000 });
      // 남은 시간은 0으로 바닥나지만 진행은 허용된다. 정보는 잃지 않는다.
      assert.equal(claim.allowed, true);
      assert.equal(typeof claim.remaining.minutes, "number", "경과·잔여 시간 보고가 사라졌다");
    });
  });

  register("토큰 예산은 record로 쌓인 실제 소비를 기준으로 막는다", () => {
    withTempRoot((root) => {
      const t0 = 1_000_000;
      initBudget({ root, session: "s1", initial: 3, retries: 2, tokens: 500_000, now: t0 });
      claimBudget({ root, session: "s1", role: "analyzer", now: t0 });
      recordSpend({ root, role: "analyzer", spentTokens: 400_000 });
      assert.equal(claimBudget({ root, session: "s1", role: "writer", now: t0 }).allowed, true, "한도 내면 통과");
      recordSpend({ root, role: "writer", spentTokens: 150_000 });
      let threw = false;
      try {
        claimBudget({ root, session: "s1", role: "pattern-extractor", now: t0 });
      } catch (e) {
        threw = true;
        assert.ok(/토큰 예산 초과/.test(e.message), `토큰 예산 메시지: ${e.message}`);
      }
      assert.ok(threw, "누적 소비가 한도를 넘으면 거부돼야 함");
      assert.equal(budgetStatus(root).used.tokens, 550_000);
    });
  });

  register("한도를 주지 않으면 시간·토큰 게이트는 적용되지 않는다 (기존 동작 보존)", () => {
    withTempRoot((root) => {
      initBudget({ root, session: "s1", initial: 3, retries: 2, now: 0 });
      recordSpend({ root, role: "analyzer", spentTokens: 99_000_000 });
      const claim = claimBudget({ root, session: "s1", role: "analyzer", now: 999 * 60_000 });
      assert.equal(claim.allowed, true, "한도 0이면 무제한이어야 함");
      assert.equal(claim.remaining.tokens, null);
      assert.equal(claim.remaining.minutes, null);
    });
  });

  register("사전 견적은 파일 수·Tier·판정 대상 미해결 건수에 따라 커진다", () => {
    const small = estimateCost({ source_file_count: 300, tier: "Standard" }, { counts: {}, coverage: {} });
    const big = estimateCost({ source_file_count: 5000, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 1500 } });
    assert.ok(big.estimated_tokens > small.estimated_tokens * 5, `대형이 훨씬 커야 함: ${small.estimated_tokens} vs ${big.estimated_tokens}`);
    assert.ok(small.estimated_minutes >= 3, "최소 추정 시간 하한");
    /* 판정 대상 미해결은 상한(2000)에서 포화한다 — 십수만 건이어도 견적이 발산하지 않아야 한다. */
    const huge = estimateCost({ source_file_count: 5000, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 500_000 } });
    const capped = estimateCost({ source_file_count: 5000, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 2000 } });
    assert.equal(huge.estimated_tokens, capped.estimated_tokens, "미해결 건수는 상한에서 포화해야 함");
  });

  register("그룹 카운트가 있으면 발생 위치 수 대신 그룹 수로 견적을 잡는다 (반복 패턴 압축)", () => {
    /* 실사용 세션 실측: 발생 위치 2,380건이 실제로는 고유 패턴 185개 — 그룹 필드가 있으면
     * 그 값을 써야 발생 위치 수를 그대로 쓸 때보다 견적이 훨씬 작아진다. */
    const withoutGroups = estimateCost({ source_file_count: 2575, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 2380 } });
    const withGroups = estimateCost({ source_file_count: 2575, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 2380, unresolved_decidable_group_count: 185 } });
    assert.ok(withGroups.estimated_tokens < withoutGroups.estimated_tokens, `그룹 카운트를 우선해야 함: ${withGroups.estimated_tokens} vs ${withoutGroups.estimated_tokens}`);
    assert.equal(withGroups.decidable_unresolved, 185, "반환값도 그룹 수를 반영해야 함");

    /* 옛 인덱스(그룹 필드 없음)는 기존 필드로 폴백해야 하위호환이 깨지지 않는다. */
    const legacyIndex = estimateCost({ source_file_count: 2575, tier: "Full" }, { counts: {}, coverage: { unresolved_decidable_count: 2380 } });
    assert.equal(legacyIndex.decidable_unresolved, 2380, "그룹 필드가 없는 옛 인덱스는 발생 위치 수로 폴백해야 함");
  });
}
