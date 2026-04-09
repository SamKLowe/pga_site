import json


def load_json(path):
    with open(path) as f:
        return json.load(f)


def normalize(name):
    return name.lower().strip()


def find_player(pick_name, score_map):
    """Match a draft pick name to a player in the leaderboard, tolerating minor differences."""
    key = normalize(pick_name)
    if key in score_map:
        return score_map[key]
    # Partial match fallback
    for player_key, player in score_map.items():
        if key in player_key or player_key in key:
            return player
    return None


def adjusted_player_score(player, current_round, cut_line_36h, total_rounds, cut_after_round):
    """
    Apply cut and WD scoring rules.
    - CUT: project average of first N rounds over remaining rounds.
    - WD: apply (cut_line_per_round + 2) for each round not played.
    Returns (adjusted_total, note) where note describes any adjustment.
    """
    status = player["status"]
    total = player["total_score"]
    round_scores = player.get("round_scores", [])
    cut_happened = current_round > cut_after_round

    if status == "STATUS_CUT" and cut_happened and len(round_scores) >= cut_after_round:
        rounds_remaining = total_rounds - cut_after_round
        avg = round(sum(round_scores[:cut_after_round]) / cut_after_round)
        adjustment = avg * rounds_remaining
        return total + adjustment, f"CUT (proj {avg:+d}/rd)"

    if status in ("STATUS_WITHDRAWN", "STATUS_WD"):
        rounds_played = len(round_scores)
        rounds_remaining = total_rounds - rounds_played
        if rounds_remaining > 0:
            if cut_happened and cut_line_36h is not None:
                penalty = cut_line_36h + 2
                return total + penalty * rounds_remaining, f"WD (cut+2={penalty:+d}/rd)"
            # WD before cut — no cut line known yet, no adjustment
        return total, "WD"

    return total, None


def calculate_standings(draft, leaderboard, config=None):
    cfg = config or {}
    total_rounds = cfg.get("total_rounds", 4)
    cut_after_round = cfg.get("cut_after_round", 2)
    current_round = leaderboard.get("round", 0)

    players_list = leaderboard.get("players", [])
    score_map = {normalize(p["name"]): p for p in players_list}

    # Determine cut line from the best (lowest) score among cut players
    cut_players = [p for p in players_list if p["status"] == "STATUS_CUT"]
    cut_line_36h = min(p["total_score"] for p in cut_players) if cut_players else None

    standings = []
    for participant in draft["participants"]:
        p_name = participant["name"]
        resolved = []

        for pick in participant["picks"]:
            player = find_player(pick, score_map)
            if player:
                adj_score, note = adjusted_player_score(
                    player, current_round, cut_line_36h, total_rounds, cut_after_round
                )
                resolved.append({
                    "name": player["name"],
                    "total_score": adj_score,
                    "status": player["status"],
                    "thru": player.get("thru", "-"),
                    "found": True,
                    "note": note,
                })
            else:
                resolved.append({
                    "name": pick,
                    "total_score": 0,
                    "status": "NOT_FOUND",
                    "thru": "-",
                    "found": False,
                    "note": None,
                })

        # Sort ascending: best (lowest) scores first
        resolved.sort(key=lambda p: p["total_score"])
        top4 = resolved[:4]
        dropped = resolved[4:]
        combined = sum(p["total_score"] for p in top4)

        standings.append({
            "participant": p_name,
            "combined_score": combined,
            "top4": top4,
            "dropped": dropped,
        })

    standings.sort(key=lambda s: s["combined_score"])

    # Find who drafted the current tournament leader
    leader_pick = None
    players = leaderboard.get("players", [])
    if players:
        leader = players[0]
        leader_key = normalize(leader["name"])
        for participant in draft["participants"]:
            for pick in participant["picks"]:
                if normalize(pick) in leader_key or leader_key in normalize(pick):
                    leader_pick = {
                        "drafted_by": participant["name"],
                        "golfer": leader["name"],
                        "score": leader["total_score"],
                    }
                    break
            if leader_pick:
                break

        # If no one drafted the leader, find the lowest scoring drafted player
        if not leader_pick:
            best = None
            for participant in draft["participants"]:
                for pick in participant["picks"]:
                    player = find_player(pick, score_map)
                    if player and player["total_score"] is not None:
                        if best is None or player["total_score"] < best["score"]:
                            best = {
                                "drafted_by": participant["name"],
                                "golfer": player["name"],
                                "score": player["total_score"],
                            }
            if best:
                best["is_fallback"] = True
            leader_pick = best

    # Build a map of player name -> participant who drafted them
    pick_owner = {}
    for participant in draft["participants"]:
        for pick in participant["picks"]:
            pick_owner[normalize(pick)] = participant["name"]

    top10 = []
    for p in leaderboard.get("players", [])[:10]:
        owner = None
        p_key = normalize(p["name"])
        for pick_key, name in pick_owner.items():
            if pick_key in p_key or p_key in pick_key:
                owner = name
                break
        top10.append({
            "name": p["name"],
            "total_score": p["total_score"],
            "status": p["status"],
            "thru": p.get("thru", "-"),
            "drafted_by": owner,
        })

    return {
        "tournament": draft["tournament"],
        "round": leaderboard["round"],
        "is_complete": leaderboard["is_complete"],
        "last_updated": leaderboard["last_updated"],
        "standings": standings,
        "leader_pick": leader_pick,
        "top10": top10,
    }
