from dataclasses import dataclass


@dataclass
class Match:
    rule_id: str | None
    severity: str
    label: str
    boxes: list
    count: int
    confidence: float


def point_in_polygon(px: float, py: float, polygon) -> bool:
    """Ray-casting test. `polygon` is a list of {"x","y"} (normalized)."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]["x"], polygon[i]["y"]
        xj, yj = polygon[j]["x"], polygon[j]["y"]
        if ((yi > py) != (yj > py)) and (
            px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def schedule_active(start, end, now_hhmm: str) -> bool:
    """True if now (``"HH:MM"``) is within [start, end). None/None = always.
    Wrap-around (start > end, e.g. 22:00->06:00) supported. Zero-padded 24h
    strings compare correctly lexicographically."""
    if not start or not end:
        return True
    if start <= end:
        return start <= now_hhmm < end
    return now_hhmm >= start or now_hhmm < end


_DEFAULT_RULE = {
    "id": None, "classes": ["person"], "zone": None,
    "schedule": [None, None], "min_confidence": None, "severity": "low",
    "enabled": True,
}


def evaluate(objects, rules, now_hhmm: str, default_conf: float) -> list[Match]:
    """One Match per rule that has >=1 surviving object. If no rules are enabled,
    a synthesized 'any person, low' default is used (implicit-default behavior)."""
    active = [r for r in rules if r.get("enabled", True)]
    if not active:
        active = [dict(_DEFAULT_RULE, min_confidence=default_conf)]

    matches: list[Match] = []
    for rule in active:
        start, end = rule.get("schedule", [None, None])
        if not schedule_active(start, end, now_hhmm):
            continue
        min_conf = rule.get("min_confidence")
        if min_conf is None:
            min_conf = default_conf
        classes = rule["classes"]
        zone = rule.get("zone")
        selected = []
        for o in objects:
            if o.label not in classes or o.conf < min_conf:
                continue
            if zone is not None and not point_in_polygon(o.x + o.w / 2, o.y + o.h, zone):
                continue
            selected.append(o)
        if not selected:
            continue
        top = max(selected, key=lambda o: o.conf)
        matches.append(
            Match(
                rule_id=rule["id"],
                severity=rule["severity"],
                label=top.label,
                boxes=selected,
                count=len(selected),
                confidence=top.conf,
            )
        )
    return matches
