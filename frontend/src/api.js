const BASE = "http://127.0.0.1:8001";
const STORAGE_KEY = "watchlist_user";

async function req(path, opts) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text).detail || text; } catch { /* not JSON, use raw text */ }
    const error = new Error(message || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// "Remember me" decides which storage a session lives in — localStorage
// survives closing the browser (what "remember" should mean), sessionStorage
// clears when the tab closes. Both are checked on load so a user isn't
// silently logged out just because they didn't tick the box last time.
export const session = {
  save(user, remember) {
    const target = remember ? localStorage : sessionStorage;
    const other = remember ? sessionStorage : localStorage;
    target.setItem(STORAGE_KEY, JSON.stringify(user));
    other.removeItem(STORAGE_KEY);
  },
  load() {
    const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  clear() {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  },
};

export const api = {
  signup: (username, password, securityQuestion, securityAnswer) =>
    req("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        security_question: securityQuestion,
        security_answer: securityAnswer,
      }),
    }),
  login: (username, password) => req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  demoLogin: () => req("/api/auth/demo", { method: "POST" }),
  getSecurityQuestion: (username) =>
    req("/api/auth/forgot-password/question", { method: "POST", body: JSON.stringify({ username }) }),
  resetPassword: (username, securityAnswer, newPassword) =>
    req("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ username, security_answer: securityAnswer, new_password: newPassword }),
    }),
  listSymbols: (q = "") => req(`/api/symbols?q=${encodeURIComponent(q)}`),
  getWatchlist: (userId) => req(`/api/watchlist/${userId}`),
  addSymbol: (userId, symbol) => req(`/api/watchlist/${userId}`, { method: "POST", body: JSON.stringify({ symbol }) }),
  removeSymbol: (userId, symbol) => req(`/api/watchlist/${userId}/${symbol}`, { method: "DELETE" }),
  ack: (userId) => req(`/api/watchlist/${userId}/ack`, { method: "POST" }),
  rollDay: () => req(`/api/admin/roll-day`, { method: "POST" }),
  marketPulse: () => req("/api/market-pulse"),
  wsUrl: () => BASE.replace("http", "ws") + "/ws/prices",
};