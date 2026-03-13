function fmtScore(score) {
  if (score === 0) return "E";
  return score > 0 ? `+${score}` : `${score}`;
}

function scoreClass(score) {
  if (score < 0) return "under";
  if (score > 0) return "over";
  return "even";
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

function rankSuffix(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function renderStandings(data) {
  // Header
  document.getElementById("tournament-name").textContent = data.tournament;
  document.getElementById("last-updated").textContent =
    "Updated: " + fmtDate(data.last_updated);
  document.getElementById("round-badge").textContent =
    data.is_complete ? "Final" : `Round ${data.round}`;

  // Winner cards
  if (data.leader_pick) {
    const lp = data.leader_pick;
    document.getElementById("leader-pick-name").textContent = lp.drafted_by;
    document.getElementById("leader-pick-detail").textContent =
      `${lp.golfer}  ${fmtScore(lp.score)}`;
  }

  const best = data.standings[0];
  if (best) {
    document.getElementById("combined-leader-name").textContent = best.participant;
    document.getElementById("combined-leader-detail").textContent =
      `Combined top-4: ${fmtScore(best.combined_score)}`;
  }

  // Standings list
  const container = document.getElementById("standings");
  container.innerHTML = "";

  data.standings.forEach((entry, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? "first" : rank === 2 ? "second" : rank === 3 ? "third" : "";

    const el = document.createElement("div");
    el.className = `entry ${rankClass}`;

    // Build picks rows
    const allPicks = [...entry.top4, ...entry.dropped];
    const droppedNames = new Set(entry.dropped.map(p => p.name));

    const pickRows = allPicks.map(pick => {
      const isDropped = droppedNames.has(pick.name);
      const isCut = pick.status && (pick.status.includes("CUT") || pick.status.includes("WITHDRAWN"));
      const badge = isCut ? `<span class="pick-badge cut">CUT</span>` :
                    !pick.found ? `<span class="pick-badge">?</span>` : "";
      return `
        <div class="pick-row ${isDropped ? "dropped" : ""}">
          <span class="pick-score ${scoreClass(pick.total_score)}">${fmtScore(pick.total_score)}</span>
          <span>${pick.name}</span>
          ${badge}
        </div>`;
    }).join("");

    el.innerHTML = `
      <div class="entry-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="rank">${rankSuffix(rank)}</span>
        <span class="p-name">${entry.participant}</span>
        <span class="p-score ${scoreClass(entry.combined_score)}">${fmtScore(entry.combined_score)}</span>
        <span class="chevron">▼</span>
      </div>
      <div class="entry-detail">
        <div class="picks-grid">${pickRows}</div>
      </div>`;

    container.appendChild(el);
  });
}

async function load() {
  try {
    const resp = await fetch("standings.json?t=" + Date.now());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderStandings(data);
  } catch (err) {
    document.getElementById("standings").innerHTML =
      `<div class="error">Could not load standings.<br><small>${err.message}</small></div>`;
  }
}

load();
// Refresh every 5 minutes
setInterval(load, 5 * 60 * 1000);
