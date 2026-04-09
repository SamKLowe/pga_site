import json
import os
import sys

from fetch_scores import fetch_leaderboard
from scoring import calculate_standings, load_json


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    config = load_json(os.path.join(root, "config.json"))

    key = config["active_tournament"]
    event_id = config.get("espn_event_id")

    draft_path = os.path.join(root, "data", f"{key}_draft.json")
    scores_path = os.path.join(root, "data", f"{key}_scores.json")
    output_path = os.path.join(root, "docs", "standings.json")

    print(f"Fetching scores for tournament: {key}")
    leaderboard = fetch_leaderboard(event_id)

    if leaderboard is None:
        print("No leaderboard data returned. Exiting.")
        sys.exit(1)

    with open(scores_path, "w") as f:
        json.dump(leaderboard, f, indent=2)
    print(f"Raw scores saved to {scores_path}")

    draft = load_json(draft_path)
    result = calculate_standings(draft, leaderboard, config=config)

    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"Standings saved to {output_path}")
    print(f"Last updated: {result['last_updated']}")


if __name__ == "__main__":
    main()
