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
  statusText.textContent = "连接中...";

  socket = io("ws://" + location.hostname + ":" + location.port, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
  });

  socket.on("connect", () => {
    connected = true;
    statusIndicator.className = "status-indicator connected";
    statusText.textContent = "已连接";
    sendBtn.disabled = false;
    chatInput.placeholder = "描述你理想中的房子...";
    addActivity("system", "系统", "已连接到智能体系统");
  });

  socket.on("disconnect", () => {
    connected = false;
    statusIndicator.className = "status-indicator disconnected";
    statusText.textContent = "已断开";
    sendBtn.disabled = true;
    chatInput.placeholder = "连接已断开，正在重连...";
    addActivity("system", "系统", "连接已断开");
  });

  socket.on("connect_error", (err) => {
    console.error("Connection error:", err.message);
    statusIndicator.className = "status-indicator disconnected";
    statusText.textContent = "连接失败: " + err.message;
    addActivity("system", "系统", "连接错误: " + err.message + " (确认服务器在 ws://localhost:3742 运行)");
  });

  socket.on("server_event", (event) => {
    handleServerEvent(event);
  });
}

// ─── Event Handler ───

function handleServerEvent(event) {
  switch (event.type) {
    case "connection_ack":
      addActivity("system", "系统", `连接已建立 (${event.payload.timestamp})`);
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
      addMessage("assistant", "系统", `❌ ${event.payload.message}`);
      break;
  }
}

// ─── Activity Feed ───

function addActivity(agentName, action, detail) {
  const item = document.createElement("div");
  item.className = `activity-item ${agentName}`;

  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
    <span class="activity-text">${emoji} <strong>${label}</strong>: ${detail}</span>
  `;

  activityFeed.appendChild(item);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}

// ─── Chat Messages ───

function addMessage(role, sender, text) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const avatar = role === "assistant" ? "🤖" : "👤";

  msg.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="message-sender">${role === "assistant" ? sender : "你"}</div>
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ─── Criteria Panel ───

function renderCriteria(criteria) {
  const tags = [];

  if (criteria.location) tags.push({ label: "位置", value: criteria.location });
  if (criteria.minPrice != null) tags.push({ label: "最低价", value: formatPrice(criteria.minPrice) });
  if (criteria.maxPrice != null) tags.push({ label: "最高价", value: formatPrice(criteria.maxPrice) });
  if (criteria.minBedrooms != null) tags.push({ label: "卧室", value: `≥ ${criteria.minBedrooms}室` });
  if (criteria.minBathrooms != null) tags.push({ label: "卫生间", value: `≥ ${criteria.minBathrooms}卫` });
  if (criteria.propertyType) tags.push({ label: "类型", value: criteria.propertyType });
  if (criteria.mustHave && criteria.mustHave.length > 0) {
    criteria.mustHave.forEach((f) => tags.push({ label: "要求", value: f }));
  }

  if (tags.length === 0) {
    criteriaBody.innerHTML = `<div class="criteria-empty">发送消息后，AI 将自动分析并更新搜索条件</div>`;
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
    propertiesGrid.innerHTML = `<div class="properties-empty">暂无匹配房源<br/><span style="font-size:12px;color:var(--text-muted)">继续添加搜索条件以获取更精准的结果</span></div>`;
    return;
  }

  propertiesGrid.innerHTML = properties.map((p) => `
    <div class="property-card" onclick="if(this.dataset.url)window.open(this.dataset.url,'_blank')" data-url="${escapeHtml(p.url)}" style="cursor:pointer">
      <img class="property-image" src="${p.imageUrl || ""}" alt="${escapeHtml(p.title)}" 
           onerror="this.style.display='none'"
           loading="lazy">
      <div class="property-body">
        <div class="property-title">${escapeHtml(p.title)}</div>
        <div class="property-location">📍 ${escapeHtml(p.location)}</div>
        <div class="property-price">$${p.price.toLocaleString()}</div>
        <div class="property-details">
          <span>🛏️ ${p.bedrooms} 室</span>
          <span>🛁 ${p.bathrooms} 卫</span>
          <span>📐 ${p.sqft?.toLocaleString() || "N/A"} sqft</span>
        </div>
        <div class="property-features">
          ${(p.features || []).map((f) => `<span class="property-feature">${escapeHtml(f)}</span>`).join("")}
        </div>
      </div>
    </div>
  `).join("");
}

// ─── Utilities ───

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatPrice(price) {
  if (price >= 1000000) return `$${(price / 1000000).toFixed(1)}M`;
  if (price >= 1000) return `$${(price / 1000).toFixed(0)}K`;
  return `$${price}`;
}

// ─── Event Handlers ───

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !connected) return;

  addMessage("user", "你", text);
  chatInput.value = "";
  chatInput.style.height = "auto";
  sendBtn.disabled = true;
  addActivity("system", "用户", `发送消息: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);

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
  addActivity("system", "系统", "活动日志已清空");
});

// Clear criteria
clearCriteriaBtn.addEventListener("click", () => {
  criteriaBody.innerHTML = `<div class="criteria-empty">搜索条件已重置</div>`;
  propertyCount.textContent = "0";
});

// ─── Init ───

connect();

// Auto-reconnect handling
setInterval(() => {
  if (!socket?.connected) {
    statusText.textContent = "正在重连...";
  }
}, 5000);
