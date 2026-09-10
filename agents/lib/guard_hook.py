# 운영 설정·자격 정보 파일 수정을 PreToolUse 훅으로 차단하는 가드 — 배포기(--root)와 훅 런타임(stdin)을 한 파일로
"""
두 가지 모드로 동작한다.

1. 배포 모드: `python guard_hook.py --root <프로젝트>`
   - `_workspace/index/env_branches.json`의 운영 프로파일 설정 파일과, 프로젝트를 걸어 찾은
     자격 정보·운영 설정 파일을 보호 목록으로 만든다(LLM 판단 없음, 파일명 규칙만).
   - 이 파일 자신을 `.claude/hooks/ax-navi-guard.py`로 복사하고 보호 목록을
     `.claude/hooks/ax-navi-guard.json`에 쓴다.
   - `.claude/settings.json`의 `hooks.PreToolUse`에 가드 항목을 멱등 병합한다. 기존 설정은 보존한다.
   - 보호 대상이 하나도 없으면 훅을 배포하지 않고, 이전에 배포한 가드 항목이 있으면 제거한다.

2. 훅 모드: 인자 없이 실행되면 stdin의 PreToolUse JSON을 읽는다.
   - Edit/Write/MultiEdit/NotebookEdit의 대상 경로가 보호 목록에 있으면 exit 2로 차단한다.
   - Bash 명령이 보호 파일을 언급하면서 쓰기 연산(리다이렉트·sed -i·rm·mv 등)을 포함하면 차단한다.
   - 그 외, 그리고 내부 오류는 exit 0(차단하지 않음). 가드의 결함으로 모든 편집이 막히는 쪽이 더 위험하다.

safe-modify의 GO/HOLD/STOP은 사후 판정이라 실행 자체를 막지 못한다. 이 훅이 그 판정 이전에
운영 DB 접속 정보·인증서·운영 프로파일 설정을 기계적으로 보호한다.
"""

import json
import os
import re
import shutil
import subprocess
import sys

HOOK_FILE_NAME = "ax-navi-guard.py"
LIST_FILE_NAME = "ax-navi-guard.json"
HOOK_MARKER = "ax-navi-guard.py"
MAX_PROTECTED = 200

EXCLUDED_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", "target", "out", ".next", ".nuxt",
    "coverage", "_workspace", "_workspace_prev", ".claude", ".idea", ".vscode", "bin", "obj",
    ".venv", "venv", "env", ".tox", "site-packages", "__pycache__", ".pytest_cache", ".mypy_cache",
}
PROD_TOKENS = {"prod", "prd", "production", "real", "live", "ops", "oper", "release", "운영"}
CONFIG_EXTS = {".yml", ".yaml", ".properties", ".xml", ".json", ".conf", ".ini", ".config", ".toml", ".env"}
CREDENTIAL_EXTS = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk"}
CREDENTIAL_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
DATASOURCE_NAMES = {
    "jdbc.properties", "database.properties", "db.properties", "datasource.properties",
    "database.yml", "database.yaml", "hibernate.cfg.xml", "context-datasource.xml", "globals.properties",
}
DOTENV_SAFE_SUFFIXES = (".example", ".sample", ".template", ".dist")
WRITE_OP_RE = re.compile(
    r"(?<![\d&])>|\bsed\s+-i|\b(?:rm|mv|cp|tee|truncate|del|erase)\b|"
    r"\b(?:Set-Content|Out-File|Add-Content|Remove-Item|Move-Item|Copy-Item)\b",
    re.IGNORECASE,
)
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def _norm(path):
    return path.replace("\\", "/").strip("/")


def _tokens(stem):
    return {t.lower() for t in re.split(r"[-_.]+", stem) if t}


def classify_file(rel):
    """보호 사유를 돌려준다. 보호 대상이 아니면 None."""
    name = os.path.basename(rel)
    stem, ext = os.path.splitext(name)
    lower = name.lower()
    if lower == ".env" or (lower.startswith(".env.") and not lower.endswith(DOTENV_SAFE_SUFFIXES)):
        return "환경 변수 파일(.env) — 자격 정보 포함 가능"
    if lower in CREDENTIAL_NAMES or ext.lower() in CREDENTIAL_EXTS:
        return "키·인증서 자료"
    if lower in DATASOURCE_NAMES:
        return "DB 접속 설정 파일"
    if ext.lower() in CONFIG_EXTS:
        if "datasource" in lower:
            return "DB 접속 설정 파일"
        if _tokens(stem) & PROD_TOKENS:
            return "운영 프로파일 설정 파일"
    return None


def _walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
        for filename in sorted(filenames):
            yield _norm(os.path.relpath(os.path.join(dirpath, filename), root))


def collect_protected(root):
    protected = {}
    env_path = os.path.join(root, "_workspace", "index", "env_branches.json")
    if os.path.isfile(env_path):
        try:
            with open(env_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            for branch in data.get("branches") or []:
                if branch.get("type") != "config_file":
                    continue
                marker = str(branch.get("marker") or "").lower()
                if marker in PROD_TOKENS and branch.get("file"):
                    protected[_norm(branch["file"])] = "운영 프로파일 설정 파일(env_branches.json)"
        except (OSError, ValueError):
            pass
    for rel in _walk(root):
        if rel in protected:
            continue
        reason = classify_file(rel)
        if reason:
            protected[rel] = reason
        if len(protected) >= MAX_PROTECTED:
            break
    return [{"path": p, "reason": protected[p]} for p in sorted(protected)]


def _python_command():
    """배포 시점에 실제로 실행되는 인터프리터 이름을 고른다(python-bin.mjs와 같은 원칙)."""
    for name in ("python3", "python", "py"):
        try:
            probe = subprocess.run([name, "--version"], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0 and "Python 3" in (probe.stdout + probe.stderr):
            return name
    return "python"


def _is_guard_entry(entry):
    return any(HOOK_MARKER in str(h.get("command", "")) for h in (entry.get("hooks") or []) if isinstance(h, dict))


def merge_settings(settings_path, enable, command):
    settings = {}
    if os.path.isfile(settings_path):
        with open(settings_path, "r", encoding="utf-8-sig") as f:
            text = f.read().strip()
        if text:
            settings = json.loads(text)
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    pre = [e for e in (hooks.get("PreToolUse") or []) if not (isinstance(e, dict) and _is_guard_entry(e))]
    if enable:
        pre.append({
            "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
            "hooks": [{"type": "command", "command": command, "timeout": 10}],
        })
    if pre:
        hooks["PreToolUse"] = pre
    else:
        hooks.pop("PreToolUse", None)
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)
    if not settings and not enable and not os.path.isfile(settings_path):
        return False
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return True


def deploy(root):
    protected = collect_protected(root)
    hooks_dir = os.path.join(root, ".claude", "hooks")
    hook_path = os.path.join(hooks_dir, HOOK_FILE_NAME)
    list_path = os.path.join(hooks_dir, LIST_FILE_NAME)
    settings_path = os.path.join(root, ".claude", "settings.json")
    if not protected:
        removed = False
        for path in (hook_path, list_path):
            if os.path.isfile(path):
                os.remove(path)
                removed = True
        merge_settings(settings_path, enable=False, command="")
        return {"protected": 0, "deployed": False, "removed_previous": removed}
    os.makedirs(hooks_dir, exist_ok=True)
    shutil.copyfile(os.path.abspath(__file__), hook_path)
    with open(list_path, "w", encoding="utf-8") as f:
        json.dump({"generated_by": "ax-navi guard_hook.py", "protected": protected}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    command = f'{_python_command()} "$CLAUDE_PROJECT_DIR/.claude/hooks/{HOOK_FILE_NAME}"'
    merge_settings(settings_path, enable=True, command=command)
    return {"protected": len(protected), "deployed": True, "removed_previous": False}


# ---------------------------------------------------------------------------
# 훅 런타임
# ---------------------------------------------------------------------------

def _project_root(payload):
    return os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()


def _load_protected(root):
    list_path = os.path.join(root, ".claude", "hooks", LIST_FILE_NAME)
    with open(list_path, "r", encoding="utf-8-sig") as f:
        return json.load(f).get("protected") or []


def _rel_of(path, root):
    if not path:
        return None
    absolute = path if os.path.isabs(path) else os.path.join(root, path)
    try:
        rel = os.path.relpath(os.path.normpath(absolute), os.path.normpath(root))
    except ValueError:
        return None
    return _norm(rel)


def _same(a, b):
    return os.path.normcase(a) == os.path.normcase(b)


def decide(payload, protected, root):
    """차단 사유 문자열 또는 None."""
    tool = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if tool in EDIT_TOOLS:
        rel = _rel_of(tool_input.get("file_path") or tool_input.get("notebook_path"), root)
        if rel is None:
            return None
        for item in protected:
            if _same(item["path"], rel):
                return f"{item['path']} — {item['reason']}"
        return None
    if tool == "Bash":
        command = str(tool_input.get("command") or "")
        if not command or not WRITE_OP_RE.search(command):
            return None
        lowered = command.lower()
        for item in protected:
            path = item["path"]
            base = os.path.basename(path)
            if path.lower() in lowered or (len(base) >= 6 and base.lower() in lowered):
                return f"{path} — {item['reason']} (Bash 쓰기 연산)"
    return None


def run_hook():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        root = _project_root(payload)
        reason = decide(payload, _load_protected(root), root)
    except Exception as e:  # 가드 결함으로 모든 편집을 막지 않는다.
        print(f"[ax-navi guard] 검사 생략 — {e}", file=sys.stderr)
        return 0
    if reason:
        print(
            f"[ax-navi guard] 보호 파일 수정 차단: {reason}. 운영 설정·자격 정보 파일은 사람이 직접 수정한다. "
            f"목록: .claude/hooks/{LIST_FILE_NAME}",
            file=sys.stderr,
        )
        return 2
    return 0


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--root":
        result = deploy(sys.argv[2])
        if result["deployed"]:
            print(f"배포 완료: .claude/hooks/{HOOK_FILE_NAME} (보호 파일 {result['protected']}개, settings.json PreToolUse 병합)")
        elif result["removed_previous"]:
            print("보호 대상 없음 — 이전 가드 훅 제거")
        else:
            print("보호 대상 없음 — 가드 훅 미배포")
        return 0
    if len(sys.argv) == 1:
        return run_hook()
    print("사용법: guard_hook.py --root <프로젝트>  |  (인자 없음) stdin PreToolUse JSON", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
