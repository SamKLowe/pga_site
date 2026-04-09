// ─── Formatting helpers ───────────────────────────────────────────────────────

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

// ─── Name normalisation (mirrors scoring.py) ─────────────────────────────────

function normalizeName(name) {
  return name
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/[ðÐ]/g, "d")
    .replace(/[þÞ]/g, "th")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritics
    .toLowerCase()
    .trim();
}

function findPlayer(pickName, scoreMap) {
  const key = normalizeName(pickName);
  if (scoreMap[key]) return scoreMap[key];
  for (const [k, v] of Object.entries(scoreMap)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
}

// ─── ESPN API parsing ─────────────────────────────────────────────────────────

const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";

function parseScore(s) {
  if (s == null) return 0;
  const str = String(s).trim().toUpperCase();
  if (str === "E" || str === "EVEN" || str === "--") return 0;
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n;
}

function parseLeaderboard(espnData, eventId) {
  const events = espnData.events || [];
  if (!events.length) return null;
  const event = events[0];

  // If ESPN returned a different event the tournament hasn't started yet
  if (String(event.id) !== String(eventId)) {
    return {
      event_name: event.name,
      round: 0,
      is_complete: false,
      last_updated: new Date().toISOString(),
      players: [],
    };
  }

  const competition = event.competitions[0];
  const status = competition.status || {};
  const currentRound = status.period || 0;
  const isComplete = status.type?.completed || false;

  const players = competition.competitors.map(comp => {
    const name = comp.athlete?.displayName || "Unknown";
    const totalScore = parseScore(comp.score);
    const statusName = comp.status?.type?.name || "STATUS_ACTIVE";

    // Round scores: completed rounds have 18 nested hole linescores
    const roundScores = (comp.linescores || [])
      .filter(ls => (ls.linescores || []).length === 18)
      .map(ls => parseScore(ls.displayValue));

    // Thru
    let thru = "-";
    for (const ls of (comp.linescores || [])) {
      if (ls.period === currentRound) {
        const holes = (ls.linescores || []).length;
        thru = holes === 18 ? "F" : holes > 0 ? String(holes) : "-";
        break;
      }
    }
    if (statusName === "STATUS_CUT" || statusName === "STATUS_WITHDRAWN") thru = statusName === "STATUS_CUT" ? "CUT" : "WD";

    return {
      name,
      total_score: totalScore,
      round_scores: roundScores,
      status: statusName,
      thru,
      position: comp.sortOrder || 999,
    };
  });

  players.sort((a, b) => a.total_score - b.total_score || a.position - b.position);

  return {
    event_name: event.name,
    round: currentRound,
    is_complete: isComplete,
    last_updated: new Date().toISOString(),
    players,
  };
}

// ─── Scoring logic (mirrors scoring.py) ──────────────────────────────────────

function adjustedScore(player, currentRound, cutLine36h, totalRounds, cutAfterRound) {
  const { status, total_score: total, round_scores: roundScores } = player;
  const cutHappened = currentRound > cutAfterRound;

  if (status === "STATUS_CUT" && cutHappened && roundScores.length >= cutAfterRound) {
    const roundsRemaining = totalRounds - cutAfterRound;
    const avg = Math.round(roundScores.slice(0, cutAfterRound).reduce((a, b) => a + b, 0) / cutAfterRound);
    return { score: total + avg * roundsRemaining, note: `CUT (proj ${avg >= 0 ? "+" : ""}${avg}/rd)` };
  }

  if (status === "STATUS_WITHDRAWN" || status === "STATUS_WD") {
    const roundsRemaining = totalRounds - roundScores.length;
    if (roundsRemaining > 0 && cutHappened && cutLine36h != null) {
      const penalty = cutLine36h + 2;
      return { score: total + penalty * roundsRemaining, note: `WD (cut+2=${penalty >= 0 ? "+" : ""}${penalty}/rd)` };
    }
    return { score: total, note: "WD" };
  }

  return { score: total, note: null };
}

function calculateStandings(draft, leaderboard, config) {
  const totalRounds = config.total_rounds || 4;
  const cutAfterRound = config.cut_after_round || 2;
  const currentRound = leaderboard.round || 0;

  const scoreMap = {};
  for (const p of leaderboard.players) {
    scoreMap[normalizeName(p.name)] = p;
  }

  const cutPlayers = leaderboard.players.filter(p => p.status === "STATUS_CUT");
  const cutLine36h = cutPlayers.length
    ? Math.min(...cutPlayers.map(p => p.total_score))
    : null;

  // Build pick owner map
  const pickOwner = {};
  for (const participant of draft.participants) {
    for (const pick of participant.picks) {
      pickOwner[normalizeName(pick)] = participant.name;
    }
  }

  const standings = draft.participants.map(participant => {
    const resolved = participant.picks.map(pick => {
      const player = findPlayer(pick, scoreMap);
      if (player) {
        const { score, note } = adjustedScore(player, currentRound, cutLine36h, totalRounds, cutAfterRound);
        return { name: player.name, total_score: score, status: player.status, thru: player.thru, found: true, note };
      }
      return { name: pick, total_score: 0, status: "NOT_FOUND", thru: "-", found: false, note: null };
    });

    resolved.sort((a, b) => a.total_score - b.total_score);
    const top4 = resolved.slice(0, 4);
    const dropped = resolved.slice(4);
    const combined = top4.reduce((s, p) => s + p.total_score, 0);

    return { participant: participant.name, combined_score: combined, top4, dropped };
  });

  standings.sort((a, b) => a.combined_score - b.combined_score);

  // Leader pick
  let leaderPick = null;
  if (leaderboard.players.length) {
    const leader = leaderboard.players[0];
    const leaderKey = normalizeName(leader.name);
    outer: for (const participant of draft.participants) {
      for (const pick of participant.picks) {
        const pk = normalizeName(pick);
        if (pk.includes(leaderKey) || leaderKey.includes(pk)) {
          leaderPick = { drafted_by: participant.name, golfer: leader.name, score: leader.total_score };
          break outer;
        }
      }
    }
    if (!leaderPick) {
      let best = null;
      for (const participant of draft.participants) {
        for (const pick of participant.picks) {
          const player = findPlayer(pick, scoreMap);
          if (player && (best === null || player.total_score < best.score)) {
            best = { drafted_by: participant.name, golfer: player.name, score: player.total_score, is_fallback: true };
          }
        }
      }
      leaderPick = best;
    }
  }

  // Top 10 with drafter
  const top10 = leaderboard.players.slice(0, 10).map(p => {
    const pKey = normalizeName(p.name);
    let owner = null;
    for (const [k, v] of Object.entries(pickOwner)) {
      if (k.includes(pKey) || pKey.includes(k)) { owner = v; break; }
    }
    return { name: p.name, total_score: p.total_score, status: p.status, thru: p.thru, drafted_by: owner };
  });

  return {
    tournament: draft.tournament,
    round: leaderboard.round,
    is_complete: leaderboard.is_complete,
    last_updated: leaderboard.last_updated,
    standings,
    leader_pick: leaderPick,
    top10,
    source: "live",
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderStandings(data) {
  document.getElementById("tournament-name").textContent = data.tournament;
  const sourceTag = data.source === "live" ? "" : " (cached)";
  document.getElementById("last-updated").textContent = "Updated: " + fmtDate(data.last_updated) + sourceTag;
  document.getElementById("round-badge").textContent =
    data.is_complete ? "Final" : data.round > 0 ? `Round ${data.round}` : "Pre-tournament";

  if (data.leader_pick) {
    const lp = data.leader_pick;
    document.getElementById("leader-pick-name").textContent = lp.drafted_by;
    document.getElementById("leader-pick-detail").textContent = lp.is_fallback
      ? `Best pick: ${lp.golfer}  ${fmtScore(lp.score)}`
      : `${lp.golfer}  ${fmtScore(lp.score)}`;
  }

  const best = data.standings[0];
  if (best) {
    document.getElementById("combined-leader-name").textContent = best.participant;
    document.getElementById("combined-leader-detail").textContent =
      `Combined top-4: ${fmtScore(best.combined_score)}`;
  }

  // Tournament leaderboard
  const lb = document.getElementById("leaderboard");
  lb.innerHTML = "";
  (data.top10 || []).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.innerHTML = `
      <span class="lb-pos">${i + 1}</span>
      <span class="lb-name">${p.name}${p.drafted_by ? `<span class="lb-owner">${p.drafted_by}</span>` : ""}</span>
      <span class="lb-thru">${p.thru || "-"}</span>
      <span class="lb-score ${scoreClass(p.total_score)}">${fmtScore(p.total_score)}</span>`;
    lb.appendChild(row);
  });

  // Standings list
  const container = document.getElementById("standings");
  container.innerHTML = "";

  data.standings.forEach((entry, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? "first" : rank === 2 ? "second" : rank === 3 ? "third" : "";

    const el = document.createElement("div");
    el.className = `entry ${rankClass}`;

    const allPicks = [...entry.top4, ...entry.dropped];
    const droppedNames = new Set(entry.dropped.map(p => p.name));

    const pickRows = allPicks.map(pick => {
      const isDropped = droppedNames.has(pick.name);
      const badge = pick.note ? `<span class="pick-badge cut">${pick.note}</span>` :
                    !pick.found ? `<span class="pick-badge">?</span>` : "";
      return `
        <div class="pick-row ${isDropped ? "dropped" : ""}">
          <span class="pick-score ${scoreClass(pick.total_score)}">${fmtScore(pick.total_score)}</span>
          <span>${pick.name}</span>
          <span class="pick-thru">${pick.thru || "-"}</span>
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

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadLive() {
  // Fetch draft config, draft picks, and ESPN scores in parallel
  // Fetch config and draft (copied to docs/ by update.py) + ESPN in parallel
  const [configResp, draftResp] = await Promise.all([
    fetch("config.json?t=" + Date.now()),
    fetch("draft.json?t=" + Date.now()),
  ]);

  if (!configResp.ok) throw new Error("Could not load config");
  if (!draftResp.ok) throw new Error("Could not load draft");
  const config = await configResp.json();
  const eventId = config.espn_event_id;

  const espnResp = await fetch(`${ESPN_URL}?event=${eventId}`);

  if (!draftResp.ok) throw new Error("Could not load draft");
  if (!espnResp.ok) throw new Error("ESPN API error");

  const [draft, espnData] = await Promise.all([draftResp.json(), espnResp.json()]);

  const leaderboard = parseLeaderboard(espnData, eventId);
  if (!leaderboard) throw new Error("No leaderboard data from ESPN");

  return calculateStandings(draft, leaderboard, config);
}

async function loadFallback() {
  const resp = await fetch("standings.json?t=" + Date.now());
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  data.source = "cached";
  return data;
}

async function load() {
  try {
    const data = await loadLive();
    renderStandings(data);
  } catch (liveErr) {
    console.warn("Live fetch failed, falling back to standings.json:", liveErr.message);
    try {
      const data = await loadFallback();
      renderStandings(data);
    } catch (fallbackErr) {
      document.getElementById("standings").innerHTML =
        `<div class="error">Could not load standings.<br><small>${fallbackErr.message}</small></div>`;
    }
  }
}

load();
// Refresh every 60 seconds (live ESPN data makes this viable)
setInterval(load, 60 * 1000);
