import express from "express";
import { randomUUID } from "node:crypto";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "dotenv";

config();
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const transports = {}; // sessionId -> transport

// Create and register a single MCP server instance
const server = new McpServer({
  name: "example-server",
  version: "1.0.0",
});

// Register handlers once
server.resource(
  "echo",
  new ResourceTemplate("echo://{message}", { list: undefined }),
  async (uri, { message }) => {
    console.error("[RESOURCE] echo called:", message);
    return {
      contents: [
        {
          uri: uri.href,
          text: `Resource echo: ${message}`,
        },
      ],
    };
  }
);

server.tool("echo", { message: z.string() }, async ({ message }) => {
  console.error("[TOOL] echo called:", message);
  return {
    content: [{ type: "text", text: `Tool echo: ${message}` }],
  };
});

server.prompt("echo", { message: z.string() }, ({ message }) => {
  console.error("[PROMPT] echo called:", message);
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please process this message: ${message}`,
        },
      },
    ],
  };
});

// Handle POST requests to /mcp
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const body = req.body;

  console.error("=== New MCP POST request ===");
  console.error("SessionId:", sessionId);
  console.error("isInitializeRequest:", isInitializeRequest(body));
  console.error("Body:", body);

  if (sessionId && transports[sessionId]) {
    // Use existing session
    const transport = transports[sessionId];
    await transport.handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    // Initialize new session
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = newTransport;
        console.error(`[INFO] New session initialized: ${id}`);
      },
    });

    newTransport.onclose = () => {
      if (newTransport.sessionId) {
        delete transports[newTransport.sessionId];
        console.error(`[INFO] Session closed: ${newTransport.sessionId}`);
      }
    };

    await server.connect(newTransport);
    await newTransport.handleRequest(req, res, body);
    return;
  }

  // Invalid request
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message: "Invalid request",
    },
    id: null,
  });
});

// GET/DELETE session messages (streamed events)
const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
app.get("/", (req, res) => {
  res.send("MCP server is running. Use /mcp for requests.");
});

app.listen(PORT, () => {
  console.error(`MCP server running at http://localhost:${PORT}/mcp`);
});
