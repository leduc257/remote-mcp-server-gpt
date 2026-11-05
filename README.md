# ChatGPT Office — Remote MCP Gateway

This repository replaces the **Authless Calculator** sample with a Cloudflare Workers MCP gateway for ChatGPT Office.

> **Status: integration scaffold; NOT production-ready.** Tools are registered, but real task access requires an Office API and OAuth provider. This gateway does not discover existing ChatGPT Scheduled Tasks, create ChatGPT cloud automations, or execute AI tasks by itself.

## Endpoints

- `GET /health` — public health check; returns whether `OFFICE_API_BASE_URL` is set, not whether backend login works.
- `/mcp` — MCP transport. Requests without a bearer token are rejected (401).

## Configure the backend

Set a Worker environment variable named `OFFICE_API_BASE_URL` (HTTPS, no trailing path required), e.g. `https://office-api.example.com`. This must point to a separately deployed and authorized Office backend; the current ChatGPT Sites `/mcp` URL is **not automatically such a backend**.

Each MCP call is forwarded as:

```http
POST {OFFICE_API_BASE_URL}/api/mcp/tools/{tool_name}
Authorization: Bearer <per-user-access-token>
Content-Type: application/json

{ ...tool_arguments }
```

The backend must implement these routes, enforce authentication and per-user authorization, and respond with the task result as JSON/text:

- `office_verify_connection`
- `office_runner_status`
- `office_configure_task`
- `office_register_schedule`
- `office_claim_due` (runner scope only)
- `office_complete_run` (runner scope only)
- `office_fail_run` (runner scope only)

**Never** use a shared user ID, `link_id`, service/admin token, or `user_id` supplied in tool arguments to choose an account. Backend must validate access token signature, issuer, audience, expiry and scopes, determine the subject, and check task/run ownership. Enforce least privilege for runner-only operations and lease-token ownership. Rate-limit and audit writes.

## OAuth is required before end-user distribution

This scaffold checks the presence of a bearer token and forwards it. **It does not issue OAuth tokens, provide discovery endpoints, validate tokens locally, implement consent/login, or integrate with ChatGPT's authorization flow.** The Office backend is required to validate tokens on every request; accepting arbitrary strings would be a severe security flaw.

Before distributing to other ChatGPT accounts:

1. Implement an OAuth 2.1 authorization server or use a trusted managed provider (PKCE, authorization code, metadata and protected resource configuration compatible with your ChatGPT MCP client).
2. Link the authenticated OAuth subject to each Office user's database records.
3. Configure OAuth discovery/WWW-Authenticate requirements for ChatGPT's MCP client.
4. Verify cross-account isolation and runner scopes.
5. Build a distributable MCP plugin package and use the ChatGPT-supported distribution process. A functioning Worker alone is not an automatically installed plugin.

## Local checks

```bash
npm install
npm run type-check
npm run dev
```

Then check `GET /health` and unauthenticated `POST /mcp` returns 401. Test authenticated `tools/list` and each tool only **after** OAuth and the Office API exist.

## Cloud Runner limitations

This gateway only exposes backend operations. It does **not** automatically link or invoke a user's personal ChatGPT Scheduled Tasks. Each user must connect an actual permitted runner schedule, and the backend must persist and verify task results. Do not claim successful execution merely because the MCP transport connects.

## Deployment safety

Changes in the PR branch are not deployed until merged/deployed. Avoid merging until the backend API and OAuth are ready; the current Calculator demo will stop working after deploying this gateway.
