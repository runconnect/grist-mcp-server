import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerGristTools } from "./tools.js";

const PORT = process.env.PORT || 3939;
const MCP_SERVER_TOKEN = process.env.MCP_SERVER_TOKEN;

const app = express();
app.use(express.json());

// --- Authentification du micro-service (distincte de la clé API Grist) ---
// Perplexity enverra ce jeton en "Authorization: Bearer <token>" si vous
// configurez le connecteur avec l'authentification "API Key".
function checkAuth(req, res, next) {
  if (!MCP_SERVER_TOKEN) return next(); // pas de protection si non configuré (déconseillé en prod)
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${MCP_SERVER_TOKEN}`;
  if (auth !== expected) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// Une session MCP par client (Perplexity garde un mcp-session-id entre les appels)
const transports = {};

function buildServer() {
  const server = new McpServer({
    name: "grist-mcp-server",
    version: "1.0.0",
  });
  registerGristTools(server);
  return server;
}

app.post("/mcp", checkAuth, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = buildServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session MCP invalide ou manquante" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp:post]", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Erreur interne du serveur MCP" },
        id: null,
      });
    }
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Session MCP invalide ou manquante");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", checkAuth, handleSessionRequest); // flux SSE serveur -> client
app.delete("/mcp", checkAuth, handleSessionRequest); // fermeture de session

// Healthcheck simple, utile pour le monitoring / certains PaaS
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Serveur MCP Grist à l'écoute sur http://localhost:${PORT}/mcp`);
});
