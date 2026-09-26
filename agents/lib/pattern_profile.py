# 프로젝트별 코드 패턴 프로필을 검증하고 작업 대상에 맞는 기준 패턴을 선택하는 도구
import argparse
import json
import os
import sys
from datetime import datetime, timezone

# Windows 콘솔은 기본 codepage(예: cp949)로 stdout을 여는데, ensure_ascii=False로 찍는 JSON에
# em-dash 등 codepage 밖 문자가 섞이면 UnicodeEncodeError로 죽는다. 항상 UTF-8로 강제한다.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass  # Python 3.6 이하 등 reconfigure 미지원 환경 — 그대로 두되 크래시는 감수


ALLOWED_STATUS = {"preferred", "legacy", "anti_pattern"}
ALLOWED_CONFIDENCE = {"HIGH", "MEDIUM", "LOW"}


def _load(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _rel_path(root, value):
    if not isinstance(value, str) or not value.strip():
        return None, "빈 경로"
    raw = value.replace("\\", "/").strip()
    if os.path.isabs(raw):
        return None, "절대 경로 금지"
    normalized = os.path.normpath(raw).replace("\\", "/")
    if normalized == ".." or normalized.startswith("../"):
        return None, "프로젝트 밖 경로 금지"
    full = os.path.abspath(os.path.join(root, normalized))
    root_abs = os.path.abspath(root)
    if os.path.commonpath([root_abs, full]) != root_abs:
        return None, "프로젝트 밖 경로 금지"
    return normalized, None


def validate_profile(root, profile_path):
    errors = []
    warnings = []
    try:
        data = _load(profile_path)
    except (OSError, json.JSONDecodeError) as e:
        return None, [f"프로필 로드 실패: {e}"], warnings

    if data.get("version") != 1:
        errors.append("version은 1이어야 함")

    profiles = data.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        errors.append("profiles는 1개 이상의 배열이어야 함")
        profiles = []

    seen = set()
    preferred_count = 0
    for index, item in enumerate(profiles):
        label = f"profiles[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label}: 객체가 아님")
            continue

        profile_id = item.get("id")
        if not isinstance(profile_id, str) or not profile_id.strip():
            errors.append(f"{label}: id 누락")
        elif profile_id in seen:
            errors.append(f"{label}: 중복 id '{profile_id}'")
        else:
            seen.add(profile_id)

        status = item.get("status")
        if status not in ALLOWED_STATUS:
            errors.append(f"{label}: status는 {sorted(ALLOWED_STATUS)} 중 하나여야 함")
        if status == "preferred":
            preferred_count += 1

        confidence = item.get("confidence")
        if confidence not in ALLOWED_CONFIDENCE:
            errors.append(f"{label}: confidence는 {sorted(ALLOWED_CONFIDENCE)} 중 하나여야 함")

        samples = item.get("samples_analyzed")
        if not isinstance(samples, int) or samples < 1:
            errors.append(f"{label}: samples_analyzed는 1 이상의 정수여야 함")
        elif samples < 5 and confidence == "HIGH":
            warnings.append(f"{label}: 샘플 {samples}개로 HIGH 신뢰도 사용")

        scope = item.get("scope")
        if not isinstance(scope, dict):
            errors.append(f"{label}: scope 객체 누락")
            scope = {}
        module = scope.get("module")
        if not isinstance(module, str) or not module.strip():
            errors.append(f"{label}: scope.module 누락 (공통은 'common' 사용)")
        layer = scope.get("layer")
        if not isinstance(layer, str) or not layer.strip():
            errors.append(f"{label}: scope.layer 누락")
        prefixes = scope.get("path_prefixes", [])
        if not isinstance(prefixes, list):
            errors.append(f"{label}: scope.path_prefixes는 배열이어야 함")
            prefixes = []
        for prefix in prefixes:
            _, path_error = _rel_path(root, prefix)
            if path_error:
                errors.append(f"{label}: 잘못된 path_prefix '{prefix}' ({path_error})")

        refs = item.get("reference_files")
        if not isinstance(refs, list):
            errors.append(f"{label}: reference_files는 배열이어야 함")
            refs = []
        if status == "preferred" and not refs:
            errors.append(f"{label}: preferred 패턴은 reference_files가 필요함")
        for ref_index, ref in enumerate(refs):
            ref_label = f"{label}.reference_files[{ref_index}]"
            path_value = ref.get("path") if isinstance(ref, dict) else None
            normalized, path_error = _rel_path(root, path_value)
            if path_error:
                errors.append(f"{ref_label}: {path_error}")
                continue
            if not os.path.isfile(os.path.join(root, normalized)):
                errors.append(f"{ref_label}: 근거 파일 없음 '{normalized}'")

        rules = item.get("rules")
        if status == "preferred" and (not isinstance(rules, dict) or not rules):
            errors.append(f"{label}: preferred 패턴은 비어 있지 않은 rules 객체가 필요함")

    if profiles and preferred_count == 0:
        errors.append("preferred 상태의 프로필이 하나 이상 필요함")

    return data, errors, warnings


def _norm(value):
    return (value or "").replace("\\", "/").strip("/").lower()


def select_profiles(data, targets, layer=None, module=None, limit=3):
    target_values = [_norm(t) for t in targets if _norm(t)]
    requested_layer = _norm(layer)
    requested_module = _norm(module)
    scored = []

    for item in data.get("profiles", []):
        if item.get("status") != "preferred":
            continue
        scope = item.get("scope") or {}
        item_layer = _norm(scope.get("layer"))
        item_module = _norm(scope.get("module"))
        prefixes = [_norm(p) for p in scope.get("path_prefixes", []) if _norm(p)]

        if requested_layer and item_layer not in {requested_layer, "common", "all"}:
            continue

        score = 0
        reasons = []
        if requested_layer and item_layer == requested_layer:
            score += 50
            reasons.append("레이어 일치")
        elif item_layer in {"common", "all"}:
            score += 5
            reasons.append("공통 패턴")

        if requested_module and item_module == requested_module:
            score += 40
            reasons.append("모듈 일치")
        elif requested_module and item_module not in {"", "common", "all"}:
            continue

        best_prefix = ""
        for target in target_values:
            for prefix in prefixes:
                if target == prefix or target.startswith(prefix + "/") or prefix.startswith(target + "/"):
                    if len(prefix) > len(best_prefix):
                        best_prefix = prefix
        if best_prefix:
            score += 100 + min(len(best_prefix), 50)
            reasons.append(f"경로 일치:{best_prefix}")
        elif prefixes and target_values:
            if item_module not in {"common", "all"} and not requested_module:
                continue
            score -= 10

        confidence = item.get("confidence")
        score += {"HIGH": 3, "MEDIUM": 2, "LOW": 1}.get(confidence, 0)
        scored.append({"score": score, "reasons": reasons, "profile": item})

    scored.sort(key=lambda row: (-row["score"], row["profile"].get("id", "")))
    # 레이어·모듈·경로 어느 것도 맞지 않은 후보(점수 0 이하)는 기준이 아니다. 실측: JSP 화면 수정에
    # Struts 설정 파일 프로필(-7점)이 골라져 엉뚱한 파일을 기준으로 읽었다. 이웃 파일로 넘긴다.
    return [row for row in scored if row["score"] > 0][:max(1, limit)]


# 이웃 파일을 찾을 때 건너뛸 폴더. 인덱서의 벤더 규칙과 같은 취지다.
SKIP_DIRS = {"node_modules", "_workspace", "bin", "obj", "target", "build", "dist", "vendor", "bower_components"}


def neighbor_references(root, targets, limit=3):
    """프로필로 기준을 못 고를 때 쓰는 결정적 기준 파일.

    예전에는 프로필이 없거나 후보가 충돌하면 사용자에게 고르게 하고 멈췄다. 레거시에서는
    대부분 그 상태라 수정마다 사람 결정을 기다렸다. 가장 가까운 기존 코드가 가장 좋은 근거라서
    대상 파일 자신 → 같은 폴더의 같은 확장자 → 한 단계 위 폴더 순으로, 이름순으로 고른다.
    """
    picked = []
    seen = set()

    def add(rel, reason):
        key = rel.lower()
        if key in seen or len(picked) >= limit + len(targets):
            return
        seen.add(key)
        picked.append({"path": rel, "reason": reason})

    for target in targets:
        rel = (target or "").replace("\\", "/").strip("/")
        if not rel:
            continue
        ext = os.path.splitext(rel)[1].lower()
        absolute = os.path.join(root, rel)
        if os.path.isfile(absolute):
            add(rel, "변경 대상 자신 — 기존 스타일 유지")
        # 신규 파일이면 폴더도 아직 없을 수 있다. 있는 폴더까지 올라간다.
        folder = os.path.dirname(absolute) if ext else absolute
        while folder and not os.path.isdir(folder) and os.path.abspath(folder) != os.path.abspath(root):
            folder = os.path.dirname(folder)
        for depth, reason in ((0, "같은 폴더의 같은 종류 파일"), (1, "상위 폴더의 같은 종류 파일")):
            base = folder if depth == 0 else os.path.dirname(folder)
            if not base or not os.path.isdir(base) or not os.path.abspath(base).startswith(os.path.abspath(root)):
                continue
            if os.path.basename(base) in SKIP_DIRS or os.path.basename(base).startswith("."):
                continue
            names = sorted(n for n in os.listdir(base) if os.path.isfile(os.path.join(base, n)))
            for name in names:
                if ext and os.path.splitext(name)[1].lower() != ext:
                    continue
                add(os.path.relpath(os.path.join(base, name), root).replace("\\", "/"), reason)
            if len(picked) >= 1 + limit:
                break
    return picked


def main():
    parser = argparse.ArgumentParser(description="패턴 프로필 검증·선택 도구")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate")
    validate.add_argument("--root", required=True)
    validate.add_argument("--profile", default=None)
    validate.add_argument("--out", default=None)

    select = sub.add_parser("select")
    select.add_argument("--root", required=True)
    select.add_argument("--profile", default=None)
    select.add_argument("--target", action="append", default=[])
    select.add_argument("--layer", default=None)
    select.add_argument("--module", default=None)
    select.add_argument("--limit", type=int, default=3)
    select.add_argument("--out", default=None)

    args = parser.parse_args()
    root = os.path.abspath(args.root)
    profile_path = args.profile or os.path.join(root, ".claude", "patterns", "pattern_profile.json")
    data, errors, warnings = validate_profile(root, profile_path)

    if args.command == "validate":
        out = args.out or os.path.join(root, "_workspace", "pattern_profile_validation.json")
        profiles = (data or {}).get("profiles", [])
        status_counts = {
            status: sum(1 for item in profiles if isinstance(item, dict) and item.get("status") == status)
            for status in sorted(ALLOWED_STATUS)
        }
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "profile": os.path.relpath(profile_path, root).replace("\\", "/"),
            "valid": not errors,
            "profiles": len(profiles),
            "status_counts": status_counts,
            "reference_files": sum(
                len(item.get("reference_files") or []) for item in profiles if isinstance(item, dict)
            ),
            "errors": errors,
            "warnings": warnings,
        }
        _write(out, report)
        print(json.dumps(report, ensure_ascii=False))
        return 1 if errors else 0

    selected = [] if errors else select_profiles(data, args.target, args.layer, args.module, args.limit)
    out = args.out or os.path.join(root, "_workspace", "reports", "pattern_selection.json")
    report = {
        "profile": os.path.relpath(profile_path, root).replace("\\", "/"),
        "request": {"targets": args.target, "layer": args.layer, "module": args.module},
        "basis": "profile" if selected else "neighbors",
        "selected": selected,
        "warnings": warnings,
    }
    if errors:
        report["errors"] = errors
    if not selected:
        # 사람에게 고르게 하지 않는다. 가장 가까운 기존 코드를 기준으로 삼고 그 사실을 남긴다.
        report["reference_files"] = neighbor_references(root, args.target, args.limit)
        report["note"] = "구조화 프로필로 기준을 고르지 못해 이웃 파일을 기준으로 삼았다. 이 파일들의 원문을 읽고 그 방식을 따른다."
    _write(out, report)
    print(json.dumps(report, ensure_ascii=False))
    if selected or report["reference_files"]:
        return 0
    return 1 if errors else 2


if __name__ == "__main__":
    sys.exit(main())
