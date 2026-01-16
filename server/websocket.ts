import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

let wss: WebSocketServer | null = null;

// Build version is set at server startup - changes after each publish/restart
export const BUILD_VERSION = Date.now().toString();
console.log(`[Server] Build version: ${BUILD_VERSION}`);

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });
  
  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");
    
    // Send current build version on connect
    ws.send(JSON.stringify({ type: "version", version: BUILD_VERSION }));
    
    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
    
    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });
  
  return wss;
}

export function broadcastOrdersUpdated() {
  if (!wss) return;
  
  const message = JSON.stringify({ type: "orders:updated" });
  
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
