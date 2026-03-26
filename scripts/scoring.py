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


def calculate_standings(draft, leaderboard):
    score_map = {normalize(p["name"]): p for p in leaderboard.get("players", [])}

    standings = []
    for participant in draft["participants"]:
        p_name = participant["name"]
        resolved = []

        for pick in participant["picks"]:
            player = find_player(pick, score_map)
            if player:
                resolved.append({
                    "name": player["name"],
                    "total_score": player["total_score"],
                    "status": player["status"],
                    "found": True,
                })
            else:
                resolved.append({
                    "name": pick,
                    "total_score": 0,
                    "status": "NOT_FOUND",
                    "found": False,
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

    return {
        "tournament": draft["tournament"],
        "round": leaderboard["round"],
        "is_complete": leaderboard["is_complete"],
        "last_updated": leaderboard["last_updated"],
        "standings": standings,
        "leader_pick": leader_pick,
    }
