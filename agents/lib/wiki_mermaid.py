# 인덱스 JSON(schema·api_contract·data_flow·external_io)을 Mermaid 마크업 페이지로 렌더링하는 zero-LLM 모듈
"""
call-graph.html은 인터랙티브 열람용이라 문서(GitHub·Confluence·PR 본문)에 붙일 수 없다.
이 모듈은 같은 인덱스에서 붙여넣기 가능한 Mermaid 마크업을 만든다.

- erDiagram: schema.json의 테이블·컬럼·FK (DDL 유도 스키마는 컬럼이 비어 있으므로 관계만)
- sequenceDiagram: data_flow.json의 엔드포인트 → 메서드 체인 → 테이블 (체인이 긴 상위 N개)
- flowchart: external_io.json의 외부 통신 대상(type별)

Mermaid 파서는 식별자·라벨의 특수문자에 취약하므로 식별자는 [A-Za-z0-9_]로 정규화하고
라벨은 따옴표 안에 넣어 따옴표·중괄호를 치환한다. 지어내는 값은 없다 — 인덱스에 없는 것은 그리지 않는다.
"""

import re

ER_TABLE_CAP = 40
ER_COLUMN_CAP = 12
SEQUENCE_ENDPOINT_CAP = 8
SEQUENCE_HOP_CAP = 8
EXTERNAL_TARGET_CAP = 30

_IDENT_RE = re.compile(r"[^A-Za-z0-9_]")


def ident(text):
    """Mermaid 노드/엔티티 식별자. 비어 있으면 '_'."""
    out = _IDENT_RE.sub("_", str(text or "")).strip("_")
    if not out:
        return "_"
    if out[0].isdigit():
        out = "_" + out
    return out


def label(text, cap=60):
    """따옴표 라벨 내부용 텍스트. 따옴표·중괄호·세미콜론을 치환하고 길이를 자른다."""
    s = str(text or "").replace('"', "'").replace("{", "(").replace("}", ")").replace(";", ",").replace("\n", " ")
    return s if len(s) <= cap else s[: cap - 1] + "…"


def _er_type(col_type):
    """erDiagram 속성 타입은 공백·괄호를 허용하지 않는다. NUMBER(19) → NUMBER_19."""
    return ident(col_type) if col_type else "unknown"


def _short_method(node_id):
    """call_graph 노드 id(예: com.acme.OrderService.cancel)를 Class.method로 줄인다."""
    s = str(node_id or "")
    s = s.split("(")[0]
    parts = [p for p in re.split(r"[./#:]", s) if p]
    return ".".join(parts[-2:]) if len(parts) >= 2 else (parts[0] if parts else s)


def _class_of(node_id):
    return _short_method(node_id).split(".")[0]


def er_diagram(schema_json):
    tables = list((schema_json or {}).get("tables") or [])
    if not tables:
        return None
    fk_degree = {}
    for t in tables:
        for fk in t.get("foreign_keys") or []:
            fk_degree[t.get("name")] = fk_degree.get(t.get("name"), 0) + 1
            ref = fk.get("references_table")
            if ref:
                fk_degree[ref] = fk_degree.get(ref, 0) + 1
    tables.sort(key=lambda t: (-(fk_degree.get(t.get("name"), 0) + int(t.get("usage_count") or 0)), str(t.get("name"))))
    chosen = tables[:ER_TABLE_CAP]
    names = {t.get("name") for t in chosen}
    lines = ["erDiagram"]
    for t in chosen:
        ent = ident(t.get("name"))
        cols = t.get("columns") or []
        if cols:
            lines.append(f"    {ent} {{")
            pk = set(t.get("primary_key") or [])
            for c in cols[:ER_COLUMN_CAP]:
                flags = " PK" if (c.get("primary_key") or c.get("name") in pk) else ""
                lines.append(f"        {_er_type(c.get('type'))} {ident(c.get('name'))}{flags}")
            if len(cols) > ER_COLUMN_CAP:
                lines.append(f"        string _more_{len(cols) - ER_COLUMN_CAP}_columns")
            lines.append("    }")
        else:
            lines.append(f"    {ent} {{")
            lines.append("    }")
    for t in chosen:
        for fk in t.get("foreign_keys") or []:
            ref = fk.get("references_table")
            if not ref or ref not in names:
                continue
            cols = ",".join(fk.get("columns") or []) or fk.get("name") or "FK"
            lines.append(f'    {ident(ref)} ||--o{{ {ident(t.get("name"))} : "{label(cols, 40)}"')
    omitted = len(tables) - len(chosen)
    note = f"\n> 테이블 {len(tables)}개 중 FK·사용 빈도 상위 {len(chosen)}개만 표시했다. 컬럼이 비어 있는 테이블은 DDL 없이 SQL에서 유도된 스키마다." if omitted > 0 else None
    return "\n".join(lines), note


def sequence_diagrams(api_contract_json, data_flow_json):
    chains = [c for c in ((data_flow_json or {}).get("chains") or []) if c.get("endpoint_id") and (c.get("method_chain") or [])]
    if not chains:
        return []
    endpoints = {e.get("id"): e for e in ((api_contract_json or {}).get("endpoints") or [])}
    chains.sort(key=lambda c: (-len(c.get("method_chain") or []), str(c.get("endpoint_id"))))
    out = []
    for c in chains[:SEQUENCE_ENDPOINT_CAP]:
        ep = endpoints.get(c["endpoint_id"]) or {}
        title = f"{ep.get('method', '')} {ep.get('path', '')}".strip() or str(c["endpoint_id"])
        hops = [m for m in (c.get("method_chain") or []) if m][:SEQUENCE_HOP_CAP]
        participants = []
        for m in ["Client"] + hops:
            cls = "Client" if m == "Client" else _class_of(m)
            if cls not in participants:
                participants.append(cls)
        lines = ["sequenceDiagram"]
        for p in participants:
            lines.append(f"    participant {ident(p)} as {label(p, 40)}")
        prev = "Client"
        for i, m in enumerate(hops):
            cls = _class_of(m)
            method = _short_method(m).split(".")[-1]
            msg = title if i == 0 else f"{method}()"
            if cls == prev:
                lines.append(f"    {ident(cls)}->>{ident(cls)}: {label(msg, 50)}")
            else:
                lines.append(f"    {ident(prev)}->>{ident(cls)}: {label(msg, 50)}")
            prev = cls
        tables = sorted(set(c.get("tables_read") or []) | set(c.get("tables_written") or []))
        if tables:
            lines.append("    participant DB as DB")
            written = set(c.get("tables_written") or [])
            for t in tables[:6]:
                verb = "write" if t in written else "read"
                lines.append(f"    {ident(prev)}->>DB: {verb} {label(t, 30)}")
        truncated = bool(c.get("truncated")) or len(c.get("method_chain") or []) > SEQUENCE_HOP_CAP
        out.append((title, "\n".join(lines), truncated))
    return out


def external_flowchart(external_io_json, own_label="이 시스템"):
    comms = (external_io_json or {}).get("communications") or []
    if not comms:
        return None
    targets = {}
    for c in comms:
        key = (c.get("type") or "etc", c.get("target") or "unknown")
        targets[key] = targets.get(key, 0) + 1
    ranked = sorted(targets.items(), key=lambda kv: (-kv[1], kv[0]))[:EXTERNAL_TARGET_CAP]
    lines = ["flowchart LR", f'    APP["{label(own_label, 30)}"]']
    for i, ((typ, target), count) in enumerate(ranked):
        node = f"T{i}"
        lines.append(f'    {node}["{label(target, 40)}"]')
        lines.append(f'    APP -->|"{label(typ, 20)} ×{count}"| {node}')
    omitted = len(targets) - len(ranked)
    note = f"\n> 통신 대상 {len(targets)}개 중 호출 수 상위 {len(ranked)}개만 표시했다." if omitted > 0 else None
    return "\n".join(lines), note


def build_diagrams(schema_json, api_contract_json, data_flow_json, external_io_json, own_label="이 시스템"):
    """diagrams.md 본문. 그릴 데이터가 하나도 없으면 None."""
    parts = ["# 다이어그램 (Mermaid)\n",
             "인덱스에서 결정론적으로 만든 Mermaid 마크업이다. 코드 블록을 그대로 복사해 GitHub·Confluence·PR 본문에 붙일 수 있다. 상세 탐색은 call-graph.html을 쓴다.\n"]
    drew = False
    er = er_diagram(schema_json)
    if er:
        drew = True
        parts.append("## ERD (schema.json)\n")
        parts.append("```mermaid\n" + er[0] + "\n```")
        if er[1]:
            parts.append(er[1])
    seqs = sequence_diagrams(api_contract_json, data_flow_json)
    if seqs:
        drew = True
        parts.append("\n## 엔드포인트 처리 흐름 (data_flow.json)\n")
        parts.append(f"메서드 체인이 긴 엔드포인트 상위 {len(seqs)}개. 홉은 {SEQUENCE_HOP_CAP}개까지만 그린다.\n")
        for title, body, truncated in seqs:
            parts.append(f"### {title}\n")
            parts.append("```mermaid\n" + body + "\n```")
            if truncated:
                parts.append("> 체인이 상한을 넘어 일부 홉을 생략했다. 전체 경로는 business-flows.md 참조.")
    ext = external_flowchart(external_io_json, own_label)
    if ext:
        drew = True
        parts.append("\n## 외부 통신 (external_io.json)\n")
        parts.append("```mermaid\n" + ext[0] + "\n```")
        if ext[1]:
            parts.append(ext[1])
    if not drew:
        return None
    return "\n".join(parts) + "\n"
