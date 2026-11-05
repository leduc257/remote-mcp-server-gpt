import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

/**
 * ChatGPT Office MCP gateway.
 *
 * This Worker never selects an Office user from tool arguments. Every request
 * forwards the caller's bearer token to the Office backend, which MUST validate
 * the token (signature, issuer, audience, expiry and scopes) and derive the user
 * identity server-side. Do not configure a shared admin token here.
 */
interface OfficeEnv {
  OFFICE_API_BASE_URL?: string;
}

const TOOLS_PREFIX = "/api/mcp/tools";

function textResult(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function createServer(env: OfficeEnv, authorization: string) {
  const server = new McpServer({ name: "ChatGPT Office", version: "2.0.0" });

  async function callOffice(tool: string, input: Record<string, unknown>) {
    const base = env.OFFICE_API_BASE_URL?.trim().replace(/\/$/, "");
    if (!base) {
      return textResult("Office backend is not configured (OFFICE_API_BASE_URL). No task data was accessed.", true);
    }

    let endpoint: URL;
    try {
      endpoint = new URL(base);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("invalid endpoint");
      }
      endpoint = new URL(endpoint.pathname.replace(/\/$/, "") + TOOLS_PREFIX + "/" + tool, endpoint.origin);
    } catch {
      return textResult("OFFICE_API_BASE_URL must be an HTTPS URL without credentials, query or fragment.", true);
    }

    try {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      });
      const body = (await response.text()).slice(0, 16000);
      if (!response.ok) {
        // Do not echo backend error bodies: they may contain sensitive details.
        return textResult(`Office backend rejected ${tool} (HTTP ${response.status}). Check your connection and permissions.`, true);
      }
      // Pass through a compact JSON result or plain text. No results are fabricated.
      return textResult(body || "Office backend returned an empty response.");
    } catch {
      return textResult(`Office backend unavailable while calling ${tool}. No result was saved.`, true);
    }
  }

  server.registerTool("office_verify_connection", {
    description: "Verify the current user's Office backend connection without running tasks.",
    inputSchema: z.object({}),
  }, async () => callOffice("office_verify_connection", {}));

  server.registerTool("office_runner_status", {
    description: "Read this signed-in user's own Office Cloud Runner connection and task statuses.",
    inputSchema: z.object({}),
  }, async () => callOffice("office_runner_status", {}));

  server.registerTool("office_configure_task", {
    description: "Update a task that belongs to the signed-in Office user. This does not edit original ChatGPT Scheduled Tasks.",
    inputSchema: z.object({
      taskId: z.string().min(1).optional(),
      conversationId: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      schedule: z.object({
        type: z.enum(["daily", "weekly", "interval"]),
        timezone: z.string().optional(),
        time: z.string().optional(),
        dayOfWeek: z.number().int().min(0).max(6).optional(),
        intervalMinutes: z.number().int().positive().optional(),
      }).optional(),
    }).refine((x) => Boolean(x.taskId || x.conversationId), "taskId or conversationId is required"),
  }, async (args) => callOffice("office_configure_task", args));

  server.registerTool("office_register_schedule", {
    description: "Associate a real, already-created cloud automation schedule with the signed-in user's Office account.",
    inputSchema: z.object({ automationId: z.string().min(1) }),
  }, async (args) => callOffice("office_register_schedule", args));

  server.registerTool("office_claim_due", {
    description: "Runner-only: claim due Office tasks for the authorized account. Requires runner scope in the backend.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(3).optional() }),
  }, async (args) => callOffice("office_claim_due", args));

  server.registerTool("office_complete_run", {
    description: "Runner-only: record an actually completed task result using the backend-issued lease token.",
    inputSchema: z.object({
      runId: z.string().min(1),
      leaseToken: z.string().min(1),
      result: z.string().min(1).max(4000),
    }),
  }, async (args) => callOffice("office_complete_run", args));

  server.registerTool("office_fail_run", {
    description: "Runner-only: record an actual execution failure using the backend-issued lease token.",
    inputSchema: z.object({
      runId: z.string().min(1),
      leaseToken: z.string().min(1),
      error: z.string().min(1).max(2000),
    }),
  }, async (args) => callOffice("office_fail_run", args));

  return server;
}

export default {
  async fetch(request: Request, env: OfficeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ service: "chatgpt-office-mcp", status: "up", backendConfigured: Boolean(env.OFFICE_API_BASE_URL) });
    }

    // Fail closed. OAuth token issuance is a separate required integration:
    // see README.md. Having a bearer token alone does NOT grant user access;
    // the Office API must verify it on every call.
    const authorization = request.headers.get("Authorization") || "";
    if (!/^Bearer\s+\S+$/i.test(authorization)) {
      return Response.json(
        { error: "authentication_required", message: "A per-user OAuth access token is required." },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="ChatGPT Office"' } },
      );
    }

    const handler = createMcpHandler(() => createServer(env, authorization));
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<OfficeEnv>;
