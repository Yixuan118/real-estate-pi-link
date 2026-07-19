import { createServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { Server, Socket } from "socket.io";
import { OrchestratorAgent } from "../agents/orchestrator-agent";
import * as store from "../core/store";
import { WsClientMessage, WsServerEvent } from "../core/types";

interface ClientState {
  socket: Socket;
  orchestrator: OrchestratorAgent;
  userId: string;
  sessionId: string | null;
}

export class WebSocketBridge {
  private io: Server;
   private httpServer: ReturnType<typeof createServer>;
  private clients: Map<string, ClientState> = new Map();
  private port: number;

  constructor(port: number = 3742) {
    this.port = port;
    this.httpServer = createServer((req, res) => {
      if (req.url?.split("?")[0] === "/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ status: "ok", service: "real-estate-pi", timestamp: new Date().toISOString() }));
        return;
      }
      const frontendDir = path.resolve(process.cwd(), "../frontend");
      const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      const fullPath = path.resolve(frontendDir, filePath);
      if (fullPath !== frontendDir && !fullPath.startsWith(frontendDir + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.readFile(fullPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(fullPath);
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
        };
        res.writeHead(200, {
          "Content-Type": mime[ext] || "application/octet-stream",
          "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
        });
        res.end(data);
      });
    });
    this.io = new Server(this.httpServer, {
      cors: { origin: true, methods: ["GET", "POST"], credentials: true },
      allowEIO3: true,
      maxHttpBufferSize: 5 * 1024 * 1024,
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.io.on("connection", async (socket: Socket) => {
      console.log("[Bridge] Client connected: " + socket.id);
      const clientId = socket.id;
      socket.emit("server_event", { type: "connection_ack", payload: { clientId, timestamp: new Date().toISOString() } });
      const orchestrator = new OrchestratorAgent();
      const userId = "user-" + clientId.slice(0, 8);
      orchestrator.onActivity((agentName, action, detail) => {
        socket.emit("server_event", { type: "agent_activity", payload: { agentName, action, detail, timestamp: new Date().toISOString() } });
      });
      this.clients.set(clientId, { socket, orchestrator, userId, sessionId: null });
      try {
        const session = await orchestrator.initialize(userId);
        const client = this.clients.get(clientId);
        if (client) client.sessionId = session.id;
        socket.emit("server_event", { type: "agent_message", payload: { agentName: "Orchestrator", text: "Hi! I'm your real estate assistant.", timestamp: new Date().toISOString() } });
      } catch (err) {
        console.error("[Bridge] Failed to init: " + clientId, err);
        socket.emit("server_event", { type: "error", payload: { message: "Failed to initialize agent system" } });
      }
      socket.on("client_message", async (data) => {
        const cs = this.clients.get(clientId);
        if (!cs) return;
        try {
          const r = await cs.orchestrator.handleUserMessage(data.text);
          socket.emit("server_event", { type: "agent_message", payload: { agentName: "Orchestrator", text: r.response, timestamp: new Date().toISOString() } });
          socket.emit("server_event", { type: "criteria_update", payload: { criteria: r.updatedCriteria, timestamp: new Date().toISOString() } });
          socket.emit("server_event", { type: "properties_update", payload: { properties: r.properties, timestamp: new Date().toISOString() } });
          socket.emit("server_event", { type: "conversation_update", payload: { conversation: r.conversation, timestamp: new Date().toISOString() } });
        } catch (err) {
          console.error("[Bridge] Error:", err);
          socket.emit("server_event", { type: "error", payload: { message: "Error processing your message" } });
        }
      });
      socket.on("disconnect", () => {
        console.log("[Bridge] Client disconnected: " + clientId);
        const cs = this.clients.get(clientId);
        if (cs) { cs.orchestrator.shutdown(); this.clients.delete(clientId); }
      });
    });
  }

  start(): void {
    this.httpServer.listen(this.port, () => {
      console.log("[Bridge] WebSocket bridge server running on port " + this.port);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.io.close(() => { this.httpServer.close(() => resolve()); });
    });
  }
}
