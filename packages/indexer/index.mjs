/*
 * 결정론적 인덱서 파사드.
 *
 * 사본을 두지 않는다. `agents/lib/*.mjs`는 Claude Code 플러그인이 계속 쓰는 파일이고
 * (플러그인 병행 유지 = 결정 D-C), 이 저장소 안에 그대로 있으므로 복사하면 두 벌이
 * 서로 어긋난다. 그래서 여기서는 re-export만 하고 타입은 index.d.ts에 손으로 적는다.
 *
 * CLI가 이 파사드를 거쳐야 하는 이유는 두 가지다.
 * - 자식 프로세스로 spawn하면 indexStaleness()의 reason 문자열이 exit 0/1로 뭉개진다.
 * - 설치 경로에 공백·한글이 섞이면(이 저장소부터가 "D:\AI\새 폴더") argv 인용이 깨진다.
 *   in-process import는 두 문제를 모두 우회한다.
 */
export {
  INDEXER_VERSION,
  buildIndex,
  indexStaleness,
  applyAiPatch,
  mergeAiPatchEdges,
  resolveIndexDir,
} from "../../agents/lib/build-index.mjs";

export { COMMANDS, loadIndex } from "../../agents/lib/query-index.mjs";
