/**
 * Prueba de humo del flujo MCP contra el servidor en marcha (sin necesidad de Claude).
 *
 * Uso:
 *   node scripts/mcp-smoke.mjs <usuario> <password> [empresaParaSeleccionar]
 *
 * Requiere que el servidor esté corriendo (npm start) y que el usuario exista.
 * Hace: initialize -> tools/list -> login -> whoami -> list_companies
 *       -> (select_company si se indica) -> bp_search.
 */

const BASE = process.env.MCP_URL || "http://localhost:3000/mcp";
const [username, password, company] = process.argv.slice(2);

if (!username || !password) {
  console.error("Uso: node scripts/mcp-smoke.mjs <usuario> <password> [empresa]");
  process.exit(1);
}

let sid = null;
let idc = 0;

function parseSSE(t) {
  const lines = t.split("\n").filter((x) => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines[lines.length - 1].slice(5).trim()) : JSON.parse(t);
}

async function rpc(method, params, notif = false) {
  const body = { jsonrpc: "2.0", method, ...(notif ? {} : { id: ++idc }), ...(params ? { params } : {}) };
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const ns = r.headers.get("mcp-session-id");
  if (ns) sid = ns;
  if (notif) return null;
  return parseSSE(await r.text());
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args || {} });
  return { isError: r?.result?.isError, text: r?.result?.content?.[0]?.text ?? JSON.stringify(r) };
}

function show(title, r) {
  console.log(`\n=== ${title} ===${r.isError ? " [ERROR]" : ""}\n${r.text}`);
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0" },
});
console.log("Servidor:", init.result.serverInfo.name, init.result.serverInfo.version);
await rpc("notifications/initialized", {}, true);

const tools = await rpc("tools/list", {});
console.log("Herramientas:", tools.result.tools.length);

show("login", await call("login", { username, password }));
show("whoami", await call("whoami", {}));
show("list_companies", await call("list_companies", {}));

if (company) {
  show("select_company", await call("select_company", { company }));
}

show("bp_search (clientes, top 5)", await call("bp_search", { cardType: "cCustomer", top: 5 }));
