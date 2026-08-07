// Real Estate Monitor - Frontend Client
// Connects to the WebSocket bridge, renders chat, activity, criteria & properties

 const WS_URL = undefined;
let socket = null;
let connected = false;

// DOM refs
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const activityFeed = document.getElementById("activityFeed");
const criteriaBody = document.getElementById("criteriaBody");
const propertiesGrid = document.getElementById("propertiesGrid");
const propertyCount = document.getElementById("propertyCount");
const statusIndicator = document.getElementById("connectionStatus");
const statusText = document.getElementById("statusText");
const clearActivityBtn = document.getElementById("clearActivity");
const clearCriteriaBtn = document.getElementById("clearCriteria");

// ─── WebSocket Connection ───

function connect() {
  if (socket?.connected) return;

  statusIndicator.className = "status-indicator";
  statusText.textContent = "Connecting…";

  socket = io({
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
  });

  socket.on("connect", () => {
    connected = true;
    statusIndicator.className = "status-indicator connected";
    statusText.textContent = "Connected";
    sendBtn.disabled = false;
    chatInput.placeholder = "Describe a property search in natural language…";
    const placeholder = chatMessages.querySelector('[data-placeholder="true"] .message-text');
    if (placeholder) placeholder.textContent = "Ready. Ask a simple search or combine listing, school, map, and neighborhood requirements.";
    addActivity("system", "System", "Connected to the multi-agent research service");
  });

  socket.on("disconnect", () => {
    connected = false;
    statusIndicator.className = "status-indicator disconnected";
    statusText.textContent = "Disconnected";
    sendBtn.disabled = true;
    chatInput.placeholder = "Connection lost. Reconnecting…";
    addActivity("system", "System", "Connection lost; retrying automatically");
  });

  socket.on("connect_error", (err) => {
    console.error("Connection error:", err.message);
    statusIndicator.className = "status-indicator disconnected";
    statusText.textContent = "Connection failed";
    addActivity("system", "System", "Connection error: " + err.message + " (confirm the service is running on port 3742)");
  });

  socket.on("server_event", (event) => {
    handleServerEvent(event);
  });
}

// ─── Event Handler ───

function handleServerEvent(event) {
  switch (event.type) {
    case "connection_ack":
      addActivity("system", "System", `Session established (${event.payload.timestamp})`);
      break;

    case "agent_activity":
      addActivity(event.payload.agentName, event.payload.action, event.payload.detail);
      break;

    case "agent_message":
      addMessage("assistant", event.payload.agentName, event.payload.text);
      break;

    case "criteria_update":
      renderCriteria(event.payload.criteria);
      break;

    case "properties_update":
      renderProperties(event.payload.properties);
      break;

    case "conversation_update":
      // Already handled via agent_message, but could re-render full history
      break;

    case "error":
      addMessage("assistant", "System", `❌ ${event.payload.message}`);
      break;
  }
}

// ─── Activity Feed ───

function addActivity(agentName, action, detail) {
  const item = document.createElement("div");
  item.className = `activity-item ${agentName}`;

  const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  let emoji = "●";
  switch (agentName) {
    case "MemoryAgent": emoji = "🧠"; break;
    case "ScraperAgent": emoji = "🔍"; break;
    case "WatcherAgent": emoji = "👁️"; break;
    case "Orchestrator": emoji = "🎯"; break;
    case "system": emoji = "⚙️"; break;
  }

  let label = agentName;
  switch (action) {
    case "busy": label += " ⏳"; break;
    case "done": label += " ✅"; break;
    case "start": label += " ▶️"; break;
    case "spawn": label += " 🔄"; break;
    case "new-properties": label += " 🎉"; break;
  }

  item.innerHTML = `
    <span class="activity-time">${time}</span>
    <span class="activity-text">${emoji} <strong>${escapeHtml(label)}</strong>: ${escapeHtml(detail)}</span>
  `;

  activityFeed.appendChild(item);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}

// ─── Chat Messages ───

function addMessage(role, sender, text) {
  chatMessages.querySelector('[data-placeholder="true"]')?.remove();
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const avatar = role === "assistant" ? "🤖" : "👤";

  msg.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="message-sender">${escapeHtml(role === "assistant" ? sender : "You")}</div>
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ─── Criteria Panel ───

function renderCriteria(criteria) {
  const tags = [];

  if (criteria.location) tags.push({ label: "Location", value: criteria.location });
  if (criteria.minPrice != null) tags.push({ label: "Min price", value: formatPrice(criteria.minPrice) });
  if (criteria.maxPrice != null) tags.push({ label: "Max price", value: formatPrice(criteria.maxPrice) });
  if (criteria.exactBedrooms != null) tags.push({ label: "Bedrooms", value: `= ${criteria.exactBedrooms}` });
  else if (criteria.minBedrooms != null) tags.push({ label: "Bedrooms", value: `≥ ${criteria.minBedrooms}` });
  if (criteria.minBathrooms != null) tags.push({ label: "Bathrooms", value: `≥ ${criteria.minBathrooms}` });
  if (criteria.propertyType) tags.push({ label: "Type", value: criteria.propertyType });
  if (criteria.mustHave && criteria.mustHave.length > 0) {
    criteria.mustHave.forEach((f) => tags.push({ label: "Required", value: f }));
  }
  (criteria.exteriorMaterials || []).forEach((f) => tags.push({ label: "Exterior", value: f === "brick" ? "four-sided brick" : f }));
  (criteria.communityFeatures || []).forEach((f) => tags.push({ label: "Community", value: f === "lake" ? "community lake" : f }));
  (criteria.distanceConstraints || []).forEach((d) => tags.push({ label: "Distance", value: `${d.name} ≤ ${d.maxMiles} mi` }));
  if (criteria.highwayAccess) {
    tags.push({ label: "Highway access", value: `${criteria.highwayAccess.highwayName} ≤ ${criteria.highwayAccess.maxMiles} mi driving` });
  }
  if (criteria.schoolMinRating != null) {
    tags.push({
      label: criteria.schoolAssignmentRequired ? "Assigned schools" : "Nearby schools",
      value: `K–12 stages all ≥ ${criteria.schoolMinRating}/10`,
    });
  }
  if (criteria.schoolAtLeastOneRating != null) {
    tags.push({ label: "School rule", value: `at least one ≥ ${criteria.schoolAtLeastOneRating}/10` });
  }

  if (tags.length === 0) {
    criteriaBody.innerHTML = `<div class="criteria-empty">Your parsed requirements will appear here.</div>`;
    return;
  }

  const html = `<div class="criteria-tags">${tags.map((t) =>
    `<span class="criteria-tag"><span class="tag-label">${t.label}</span><span class="tag-value">${escapeHtml(t.value)}</span></span>`
  ).join("")}</div>`;

  criteriaBody.innerHTML = html;
}

// ─── Properties Panel ───

function renderProperties(properties) {
  propertyCount.textContent = properties.length;

  if (properties.length === 0) {
    propertiesGrid.innerHTML = `<div class="properties-empty"><strong>No retained candidates.</strong><br/><span>Review the activity log for source or evidence errors, or adjust a hard requirement.</span></div>`;
    return;
  }

  propertiesGrid.innerHTML = properties.map((p) => {
    const listingUrl = normalizeListingUrl(p.url);
    const zillowUrl = buildZillowSearchUrl(p.title);
    return `
    <article class="property-card property-card-${p.criteriaMatch?.overall || "unassessed"}">
      ${p.imageUrl ? `<div class="property-image-frame">
        <img class="property-image" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.title)}"
             onerror="this.closest('.property-image-frame').style.display='none'"
             loading="lazy">
      </div>` : ""}
      <div class="property-body">
        <div class="property-title">${escapeHtml(p.title)}</div>
        <div class="property-location">📍 ${escapeHtml(p.location)}</div>
        <div class="property-price">$${p.price.toLocaleString()}</div>
        <div class="property-details">
          <span>${Number(p.bedrooms) > 0 ? `${p.bedrooms} beds` : p.bedroomsSource ? "Studio" : "Beds unavailable"}</span>
          <span>${formatBathrooms(p)}</span>
          <span>📐 ${p.sqft?.toLocaleString() || "N/A"} sqft</span>
        </div>
        <div class="property-features">
          ${(p.features || []).map((f) => `<span class="property-feature">${escapeHtml(f)}</span>`).join("")}
        </div>
        <div class="property-source-links">
          ${listingUrl ? `<a class="primary-link" href="${escapeHtml(listingUrl)}" target="_blank" rel="noopener">Open Realtor listing ↗</a>` : ""}
          <a href="${escapeHtml(zillowUrl)}" target="_blank" rel="noopener">Search on Zillow ↗</a>
        </div>
        ${renderSchoolEvidence(p.schools, p.schoolDistricts)}
        ${renderWaterbodyEvidence(p.nearbyWaterBodies)}
        ${renderMatchEvidence(p.criteriaMatch)}
        ${renderListingFacts(p.listingFacts, p.listingEvidenceSourceUrl || listingUrl)}
        ${renderEvidenceDiagnostics(p.evidenceDiagnostics)}
      </div>
    </article>
  `}).join("");
}

function renderSchoolEvidence(schools, districts) {
  const rows = (schools || []).filter((school) => school.relationship === "assigned"
    || school.relationship === "assignment-option" || school.relationship === "listing-associated" || school.rating != null);
  if (rows.length === 0 && !(districts || []).length) return "";
  const typeLabels = { elementary: "Elementary", middle: "Middle", high: "High", k12: "K–12", other: "School" };
  return `<div class="property-school-evidence">
    ${(districts || []).slice(0, 1).map((district) => `<div class="property-school-district">🏫 ${escapeHtml(district.name)}</div>`).join("")}
    ${rows.slice(0, 8).map((school) => {
      const rating = school.rating != null ? `${school.rating}/10` : "rating unavailable";
      const relationship = school.relationship === "assigned" ? "officially assigned" : school.relationship === "assignment-option" ? "official option" : school.relationship === "listing-associated" ? "listed for this property" : "nearby";
      const details = [school.grades ? `grades ${school.grades}` : "", Number.isFinite(school.distanceMiles) ? `${school.distanceMiles} mi away` : "",
        Number.isFinite(school.studentCount) ? `${school.studentCount} students` : "", Number.isFinite(school.reviewCount) ? `${school.reviewCount} reviews` : ""].filter(Boolean);
      const content = `${typeLabels[school.type] || "School"} · ${school.name} · ${rating} · ${relationship}${details.length ? ` · ${details.join(" · ")}` : ""}`;
      return school.sourceUrl
        ? `<a href="${escapeHtml(school.sourceUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escapeHtml(content)}</a>`
        : `<div>${escapeHtml(content)}</div>`;
    }).join("")}
  </div>`;
}

function renderWaterbodyEvidence(waterBodies) {
  const nearest = (waterBodies || [])[0];
  if (!nearest) return "";
  const area = Number(nearest.areaAcres) > 0 ? ` · ${Number(nearest.areaAcres).toFixed(1)} acres` : "";
  const content = `Mapped waterbody · ${nearest.name} · ${Number(nearest.distanceMiles).toFixed(2)} mi${area} · ${nearest.source}`;
  return `<div class="property-waterbody-evidence">
    ${nearest.sourceUrl
      ? `<a href="${escapeHtml(nearest.sourceUrl)}" target="_blank" rel="noopener">💧 ${escapeHtml(content)}</a>`
      : `<div>💧 ${escapeHtml(content)}</div>`}
    <small>Map proximity does not by itself prove subdivision ownership or resident access.</small>
  </div>`;
}

function renderMatchEvidence(match) {
  if (!match || !Array.isArray(match.checks) || match.checks.length === 0) return "";
  const icons = { verified: "✅", failed: "❌", unknown: "⚠️" };
  const heading = match.overall === "verified" ? "All requested criteria verified" : match.overall === "failed" ? "Hard criterion failed" : "Evidence still required";
  return `<div class="property-match property-match-${match.overall}">
    <div class="property-match-heading">${icons[match.overall] || "⚠️"} ${heading} · ${match.score}%</div>
    ${match.checks.map((check) => `<div class="property-match-check">
      <div>${icons[check.status] || "⚠️"} ${escapeHtml(check.criterion)}</div>
      <div class="property-match-detail">${escapeHtml(check.detail)}</div>
    </div>`).join("")}
  </div>`;
}

function renderListingFacts(facts, sourceUrl) {
  const entries = Object.entries(facts || {});
  if (!entries.length) return "";
  const priority = /architectural|construction|community|amenit|school|subdivision|roof|parking|heating|cooling|utility/i;
  entries.sort((a, b) => Number(priority.test(b[0])) - Number(priority.test(a[0])) || a[0].localeCompare(b[0]));
  const rows = entries.slice(0, 10).map(([label, values]) =>
    `<div class="listing-fact"><dt>${escapeHtml(label.replace(/^Listing:\s*/i, ""))}</dt><dd>${escapeHtml((values || []).join(" · "))}</dd></div>`
  ).join("");
  return `<details class="listing-evidence">
    <summary>Listing evidence snapshot <span>${entries.length} facts</span></summary>
    <dl>${rows}</dl>
    ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">Review source page ↗</a>` : ""}
  </details>`;
}

function renderEvidenceDiagnostics(diagnostics) {
  const issues = (diagnostics || []).filter((item) =>
    item.status !== "success" && item.stage !== "listing-search");
  if (issues.length === 0) return "";
  return `<div class="property-evidence-diagnostics">
    ${issues.slice(0, 3).map((item) => `<div>ℹ️ ${escapeHtml(item.stage)}: ${escapeHtml(item.detail)}</div>`).join("")}
  </div>`;
}

// ─── Utilities ───

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function normalizeListingUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://www.realtor.com${url.startsWith("/") ? "" : "/"}${url}`;
}

function buildZillowSearchUrl(address) {
  const slug = String(address || "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `https://www.zillow.com/homes/${slug}_rb/`;
}

function formatPrice(price) {
  if (price >= 1000000) return `$${(price / 1000000).toFixed(1)}M`;
  if (price >= 1000) return `$${(price / 1000).toFixed(0)}K`;
  return `$${price}`;
}

function formatBathrooms(property) {
  const total = Number(property.bathrooms);
  const full = Number(property.fullBathrooms);
  const half = Number(property.halfBathrooms);
  const breakdownTotal = full > 0 && half >= 0 ? full + (half * 0.5) : 0;
  // The server normally enforces this invariant. Recompute defensively so the
  // UI can never display an internally contradictory total and breakdown.
  if (full > 0 && half > 0) return `${breakdownTotal} baths (${full} full, ${half} half)`;
  if (full > 0) return `${breakdownTotal || total || full} baths (${full} full)`;
  return total > 0 ? `${total} baths` : "Baths unavailable";
}

// ─── Event Handlers ───

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !connected) return;

  addMessage("user", "You", text);
  chatInput.value = "";
  chatInput.style.height = "auto";
  sendBtn.disabled = true;
  addActivity("system", "User", `Submitted: "${text.slice(0, 70)}${text.length > 70 ? "…" : ""}"`);

  socket.emit("client_message", { type: "user_message", text }, () => {
    sendBtn.disabled = false;
  });

  // Fallback if ack doesn't come
  setTimeout(() => { sendBtn.disabled = false; }, 30000);
}

// Input handling
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Auto-resize
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});

sendBtn.addEventListener("click", sendMessage);

// Clear activity
clearActivityBtn.addEventListener("click", () => {
  activityFeed.innerHTML = "";
  addActivity("system", "System", "Activity log cleared");
});

// Clear criteria
clearCriteriaBtn.addEventListener("click", () => {
  criteriaBody.innerHTML = `<div class="criteria-empty">Criteria view reset. Send a new request to search again.</div>`;
  propertyCount.textContent = "0";
});

// ─── Init ───

connect();

document.querySelectorAll(".prompt-chip").forEach((button) => {
  button.addEventListener("click", () => {
    chatInput.value = button.dataset.prompt || "";
    chatInput.focus();
  });
});

// Auto-reconnect handling
setInterval(() => {
  if (!socket?.connected) {
    statusText.textContent = "Reconnecting…";
  }
}, 5000);
