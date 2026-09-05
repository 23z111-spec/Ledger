const BASE = "http://127.0.0.1:8000";

async function req(path, opts) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

export const api = {
  createUser: (username) => req("/api/users", { method: "POST", body: JSON.stringify({ username }) }),
  listSymbols: (q = "") => req(`/api/symbols?q=${encodeURIComponent(q)}`),
  getWatchlist: (userId) => req(`/api/watchlist/${userId}`),
  addSymbol: (userId, symbol) => req(`/api/watchlist/${userId}`, { method: "POST", body: JSON.stringify({ symbol }) }),
  removeSymbol: (userId, symbol) => req(`/api/watchlist/${userId}/${symbol}`, { method: "DELETE" }),
  ack: (userId) => req(`/api/watchlist/${userId}/ack`, { method: "POST" }),
  rollDay: () => req(`/api/admin/roll-day`, { method: "POST" }),
  wsUrl: () => BASE.replace("http", "ws") + "/ws/prices",
};
