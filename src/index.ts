import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { createMcpServer } from "./server.js";
import { logout, sweepSessions } from "./auth/session.js";
import { sweepPending } from "./pending/store.js";
import { logoutAllClients } from "./sap/serviceLayer.js";
import { getAllCompanies } from "./sap/companies.js";

/**
 * Servidor MCP central por HTTP (StreamableHTTP, con SSE para notificaciones).
 *
 * Mantiene un transporte por sesión MCP. El sessionId que genera el transporte
 * es la clave con la que la capa de auth asocia al usuario autenticado, de modo
 * que cada conexión sostiene su propia identidad y permisos.
 */

const app = express();
app.use(express.json({ limit: "4mb" }));

// transporte y server MCP por sesión
const transports = new Map<string, StreamableHTTPServerTransport>();

// /health no requiere API key (lo usa el healthcheck de la plataforma).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "mcp-sap-b1", sessions: transports.size });
});

// Protección por API key (opcional pero recomendada al exponer públicamente).
// Acepta cabecera 'x-api-key' o 'Authorization: Bearer <key>'.
if (config.security.apiKey) {
  app.use(config.server.path, (req, res, next) => {
    const headerKey =
      (req.headers["x-api-key"] as string | undefined) ??
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined);
    if (headerKey !== config.security.apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "No autorizado: falta o es inválida la API key." },
        id: null,
      });
      return;
    }
    next();
  });
}

app.post(config.server.path, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (isInitializeRequest(req.body)) {
      // Nueva sesión.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
        },
      });

      transport.onclose = () => {
        if (transport!.sessionId) {
          logout(transport!.sessionId);
          transports.delete(transport!.sessionId);
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else if (sessionId) {
      // El cliente envió un ID de sesión que ya no existe (el servidor se
      // reinició/redeployó o la sesión expiró). Devolvemos 404 para que el
      // cliente reinicie la sesión automáticamente (comportamiento del estándar
      // MCP). Devolver 400 dejaba a Claude atascado con "error de ejecución".
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Sesión no encontrada o expirada. Reinicie con 'initialize'." },
        id: (req.body && (req.body as any).id) ?? null,
      });
      return;
    } else {
      // Sin sesión y sin ser initialize.
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Falta sesión válida: envíe primero una petición initialize." },
        id: null,
      });
      return;
    }
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp-sap-b1] error manejando POST:", (e as Error).stack ?? e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Error interno: ${(e as Error).message}` },
        id: (req.body && (req.body as any).id) ?? null,
      });
    }
  }
});

// Canal SSE para notificaciones servidor->cliente.
app.get(config.server.path, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    // 404 si la sesión no existe (cliente debe reiniciar); 400 si ni la envió.
    res.status(sessionId ? 404 : 400).send("Sesión no encontrada o ausente.");
    return;
  }
  await transport.handleRequest(req, res);
});

// Terminación de sesión.
app.delete(config.server.path, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(sessionId ? 404 : 400).send("Sesión no encontrada o ausente.");
    return;
  }
  await transport.handleRequest(req, res);
});

// Limpieza periódica de sesiones y acciones pendientes expiradas.
const sweepTimer = setInterval(() => {
  sweepSessions();
  sweepPending();
}, 60_000);
sweepTimer.unref();

const httpServer = app.listen(config.server.port, config.server.host, () => {
  console.error(
    `[mcp-sap-b1] escuchando en http://${config.server.host}:${config.server.port}${config.server.path}`,
  );
  try {
    const cos = getAllCompanies();
    console.error(
      `[mcp-sap-b1] SAP Service Layer: ${config.sap.url} — ${cos.length} empresa(s): ` +
        cos.map((c) => `${c.alias}(${c.companyDB})`).join(", "),
    );
  } catch (e) {
    console.error(`[mcp-sap-b1] ⚠️ Configuración de empresas: ${(e as Error).message}`);
  }
});

async function shutdown() {
  console.error("[mcp-sap-b1] cerrando…");
  clearInterval(sweepTimer);
  for (const t of transports.values()) {
    try {
      await t.close();
    } catch {
      /* ignore */
    }
  }
  await logoutAllClients();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
