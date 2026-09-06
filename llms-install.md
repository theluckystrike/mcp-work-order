# Installing mcp-work-order (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Work orders** (@theluckystrike/mcp-work-order)
What it does: Run job orders for trades and field work. Raise a work order against a client, with a site address, the date it was asked for, what the job is and how urgent. Log parts (quantity and unit cost in minor units, with an optional markup on the unit) and labour (hours at an hourly rate). Move it one step at a time through draft, scheduled, in_progress, done and invoiced, each step stamped. Hand the customer a completion report as text or A4 PDF with a sign-off block, and take an `invoice_create`-ready payload to the invoice server. No total is stored; every figure is derived from the lines on the call.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/work-order
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-work-order` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`. Everything else on this page is unchanged.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native dependencies. The package is pure JavaScript.
- No sibling server is required at runtime. This one reads two files it does not own, both read-only and both best-effort: the shared business profile (currency, VAT rate, business name), which the invoice server's `business_set` writes, and the invoice server's `clients.json`, so a job carries the same client record the invoice will be raised against. Neither is written.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-work-order
```

The server speaks MCP over stdio. It writes nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`.
Merge this entry into the existing `mcpServers` object; do not overwrite the file.

```json
{
  "mcpServers": {
    "work-order": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-work-order"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add work-order -- npx -y @theluckystrike/mcp-work-order
```

### Cursor

File: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Same entry as Claude Desktop.

### Cline

File: `cline_mcp_settings.json` (VS Code: Cline panel -> MCP Servers -> Configure MCP Servers). Merge:

```json
{
  "mcpServers": {
    "work-order": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-work-order"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Step 3 - restart the client and verify

Restart the client, then call `license_status`. A successful call returns the current mode (free or pro) and proves the transport works. Then read the `workorder://board` resource: it lists the five statuses in order, the free-tier limits, the one directory this server writes and the one file it reads. Then run the worked check: `work_order_create` with a client, a site address, `requested_date` 2026-03-02 and a description; `work_order_add_line` with `kind` parts, `quantity` 7, `unit_cost_minor` 1299 and `markup_percent` 15. The billed unit must come back as 1494 and the line value as 10458, not 10457. `tools/list` must show the twelve tools from the server README.

## Optional - Pro key

A Pro key removes the free-tier limits listed in the README. Either add it to the config:

```json
"env": { "MCP_LICENSE_KEY": "MCPL1..." }
```

or call the `license_activate` tool once with the key. Keys are verified offline; nothing is sent anywhere. Keys: https://mcp.zovo.one/buy/work-order

## Alternative A - .mcpb bundle (Claude Desktop one-click)

Download `work-order.mcpb` from https://github.com/theluckystrike/mcp-servers/releases and open it, or drag it onto the Claude Desktop Extensions pane. This installs the server without editing JSON and without Node on PATH assumptions.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build --workspaces --if-present
```

The money and VAT arithmetic is imported from `mcp-invoice`, the A4 renderer from `mcp-billing-docs`, the timezone-aware "today" from `mcp-quotes` and the corrupt-store quarantine from `mcp-timezone`, so build the workspaces before this server rather than this server alone.
Then use `"command": "node", "args": ["<abs path>/mcp-servers/servers/work-order/dist/index.js"]`.

## Alternative C - Docker

```sh
docker buildx build -f servers/work-order/Dockerfile -t mcp-work-order .
```

The build context is the repository root. Run with `docker run -i --rm -v mcp-servers-data:/root/.local/share/mcp-servers mcp-work-order`.

## Troubleshooting

- `command not found: npx` - install Node.js 18+.
- Tools missing after config edit - the client only reads the config at startup; restart it fully.
- `"the free tier holds 5 open work orders"` - the cap counts OPEN orders (draft, scheduled, in_progress), not every job you have ever raised. Move one to done, or delete a draft with no lines. Both are free.
- `"no client record matches ..."` - a bare name that matches nothing is a misspelling far more often than a new customer. Run `client_add` in the invoice server, or pass `client_address` here and the job records the client inline.
- `"is draft, and the next status is scheduled, not done"` - the status machine moves one step at a time so every step keeps its own date. Move through the steps.
- `"needs rate_minor"` - the shared business profile has no default hourly rate field, so nothing here can supply one and a rate this server invented would end up on an invoice. Pass `rate_minor` in whole minor units.
- `"carries N line(s) ... and cannot be deleted"` - parts and hours on a job are a record of what was used. A draft with no lines deletes free; anything else is corrected, not erased.
- The invoice total does not match my own spreadsheet by a cent - check where you applied the markup. It goes on the UNIT cost, which is the basis the invoice server rounds on. Seven at 1299 plus 15 percent is 1494 x 7 = 10,458, not `round(9093 x 1.15)` = 10,457.
- Data location: this server writes only `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/work-order/orders.json`, `counter.json` and `pdf/`, and nothing else anywhere. `work_order_invoice_payload` creates no invoice and marks nothing; raise the invoice in the invoice server, then set the status to invoiced here.

Built by theluckystrike (https://github.com/theluckystrike).
