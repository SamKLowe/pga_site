import requests
import json
from datetime import datetime, timezone

ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard"


def parse_score(score_str):
    """Convert ESPN score string to integer. 'E' -> 0, '-5' -> -5, '+3' -> 3"""
    if score_str is None:
        return None
    s = str(score_str).strip()
    if s.upper() in ("E", "EVEN", "--"):
        return 0
    try:
        return int(s)
    except ValueError:
        return None


def fetch_leaderboard(event_id=None):
    params = {}
    if event_id:
        params["event"] = event_id

    resp = requests.get(ESPN_URL, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    events = data.get("events", [])
    if not events:
        print("No events found in ESPN response.")
        return None

    event = events[0]
    event_name = event.get("name", "Unknown Tournament")

    # If we requested a specific event but ESPN returned a different one,
    # the tournament hasn't started yet — return zeros for all picks.
    if event_id and str(event.get("id", "")) != str(event_id):
        print(f"ESPN returned '{event_name}' instead of requested event {event_id} — tournament not started yet.")
        return {
            "event_name": event_name,
            "round": 1,
            "is_complete": False,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "players": [],
        }
    competition = event.get("competitions", [{}])[0]
    status = competition.get("status", {})
    round_num = status.get("period", 1)
    is_complete = status.get("type", {}).get("completed", False)

    players = []
    for comp in competition.get("competitors", []):
        athlete = comp.get("athlete", {})
        name = athlete.get("displayName", "Unknown")

        total_score = parse_score(comp.get("score", "E"))
        if total_score is None:
            total_score = 0

        status_name = comp.get("status", {}).get("type", {}).get("name", "STATUS_ACTIVE")

        round_scores = []
        for ls in comp.get("linescores", []):
            val = parse_score(ls.get("value"))
            if val is not None:
                round_scores.append(val)

        # Derive "thru" from holes completed in the current round
        thru = "-"
        for ls in comp.get("linescores", []):
            if ls.get("period") == round_num:
                holes = len(ls.get("linescores", []))
                if holes == 18:
                    thru = "F"
                elif holes > 0:
                    thru = str(holes)
                break

        if status_name in ("STATUS_CUT", "STATUS_WITHDRAWN"):
            thru = "CUT"

        players.append({
            "name": name,
            "total_score": total_score,
            "round_scores": round_scores,
            "status": status_name,
            "position": comp.get("sortOrder", 999),
            "thru": thru,
        })

    players.sort(key=lambda p: (p["total_score"], p["position"]))

    return {
        "event_name": event_name,
        "round": round_num,
        "is_complete": is_complete,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "players": players,
    }


if __name__ == "__main__":
    result = fetch_leaderboard()
    print(json.dumps(result, indent=2))
