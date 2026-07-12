from .rules import Match, point_in_polygon, schedule_active


def bottom_center(o):
    return (o.x + o.w / 2.0, o.y + o.h)


def _side(a, b, p):
    """Signed side of point p relative to the directed line a->b (cross product)."""
    return (b["x"] - a["x"]) * (p[1] - a["y"]) - (b["y"] - a["y"]) * (p[0] - a["x"])


def _ccw(ax, ay, bx, by, cx, cy):
    return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)


def _segments_intersect(p1, p2, p3, p4):
    d1 = _ccw(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])
    d2 = _ccw(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])
    d3 = _ccw(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
    d4 = _ccw(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def segment_crosses(prev, cur, line, direction) -> bool:
    """True if the prev->cur segment crosses the line segment (line = [A, B] with
    {"x","y"}) in the requested sense. `both` = either way; `in` = the object's
    signed side goes from + to - across A->B; `out` = the reverse."""
    a, b = line[0], line[1]
    if not _segments_intersect(prev, cur, (a["x"], a["y"]), (b["x"], b["y"])):
        return False
    if direction == "both" or direction is None:
        return True
    s_prev = _side(a, b, prev)
    s_cur = _side(a, b, cur)
    if direction == "in":
        return s_prev > 0 and s_cur < 0
    if direction == "out":
        return s_prev < 0 and s_cur > 0
    return False


class DwellState:
    def __init__(self):
        self.entered_at = None
        self.fired = False


def evaluate_tracking(tracks, rules, state, last_center, now_s, now_hhmm, default_conf):
    """Matches for tripwire/dwell rules. `state` is a dict keyed (rule_id, track_id)
    of DwellState (mutated in place); `last_center` maps track_id -> previous
    bottom-center (the caller updates it after this returns)."""
    matches = []
    for rule in rules:
        if not rule.get("enabled", True):
            continue
        s, e = rule.get("schedule", [None, None])
        if not schedule_active(s, e, now_hhmm):
            continue
        # tripwire/dwell always need geometry; if the zone was deleted the rule is
        # orphaned (zone=None) — skip it rather than crash on rule["zone"][0].
        if not rule.get("zone"):
            continue
        min_conf = rule.get("min_confidence") or default_conf
        classes = rule["classes"]
        rid = rule["id"]
        sev = rule["severity"]
        sel = [t for t in tracks if t.label in classes and t.conf >= min_conf]
        typ = rule["type"]

        if typ == "tripwire":
            line = rule["zone"]
            direction = rule.get("direction", "both")
            for t in sel:
                prev = last_center.get(t.id)
                if prev is None:
                    continue
                if segment_crosses(prev, bottom_center(t), line, direction):
                    matches.append(Match(rid, sev, t.label, [t], 1, t.conf))

        elif typ == "dwell":
            zone = rule["zone"]
            dwell = rule.get("dwell_seconds") or 0
            present = set()
            for t in sel:
                cx, cy = bottom_center(t)
                if point_in_polygon(cx, cy, zone):
                    present.add(t.id)
                    st = state.setdefault((rid, t.id), DwellState())
                    if st.entered_at is None:
                        st.entered_at = now_s
                    if not st.fired and now_s - st.entered_at >= dwell:
                        st.fired = True
                        matches.append(Match(rid, sev, t.label, [t], 1, t.conf))
            # a track no longer inside this rule's zone -> drop its state so a later
            # re-entry starts a FRESH episode timed from the re-entry (dwell = time
            # spent CONTINUOUSLY inside). Also bounds `state` (no leak on churn).
            for key in [k for k in state if k[0] == rid and k[1] not in present]:
                del state[key]
    return matches
