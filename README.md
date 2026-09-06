# mcp-work-order

![work-order demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-work-order.gif)

**One-click install:** download `work-order.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it in Claude Desktop.

**Hosted endpoint (no install):** `https://mcp.zovo.one/mcp/work-order` (streamable-http; send `Authorization: Bearer <Pro key or anonymous token from https://mcp.zovo.one/mcp/token>`).

Read-only mirror of [mcp-servers/servers/work-order](https://github.com/theluckystrike/mcp-servers/tree/main/servers/work-order). See [MIRROR.md](MIRROR.md).


Job orders for trades and field work, kept the way a job card is kept. Raise a work order
against a client (the same client record your invoices use), give it a site address, the
date it was asked for, what the job is and how urgent. Log what the job actually used as it
goes: labour as hours at a rate, parts as a quantity at a unit cost with an optional markup.
Move it along one step at a time, draft to scheduled to in progress to done to invoiced,
each step stamped with its date and a note. When it is finished, hand the customer a
completion report with the hours, the materials, the totals and a sign-off block, and take
the invoice payload straight to `invoice_create` without retyping a single figure.

Nothing is invented and nothing is stored twice: the value, the hours, the materials and
the VAT are derived from the lines on every call, and the invoice payload's unit prices are
already the billed units, so the invoice reproduces the work order to the minor unit.

## Install

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), same entry as Claude Desktop.

## Tools

| Tool | What it does |
| --- | --- |
| `work_order_create` | Raise a job order and return its `WO-YYYY-NNNN` number: client, site address, requested date, description, priority |
| `work_order_add_line` | Add one line: parts with a quantity and a unit cost in minor units and an optional markup percent, or labour with hours and an hourly rate |
| `work_order_status` | Move it one step: draft, scheduled, in_progress, done, invoiced, stamping the date and a note |
| `work_order_get` | One work order in full: every line with its billed unit, the hours, the materials, net and VAT, and the status history |
| `work_order_list` | List work orders by status, by client and by requested-date range |
| `work_order_delete` | Delete a work order raised by mistake. Draft with no lines only. Free on every tier |
| `completion_report_text` | The completion report as plain text, ready to paste into an email |
| `completion_report_pdf` | The completion report as an A4 PDF, with the sign-off block |
| `work_order_invoice_payload` | An `invoice_create`-ready payload from the lines, with VAT at the shared profile rate |
| `work_orders_report` | The whole board: work orders per status, hours logged this month, unbilled value per currency |
| `license_status` / `license_activate` | Free or Pro, and where to upgrade |

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Open work orders | 5 | unlimited |
| Lines per work order | 200 | 200 |
| Raise, log, move, list, delete | yes | yes |
| Completion report (text) | yes | yes |
| Completion report (PDF) | no | yes |
| Invoice payload | no | yes |
| Board report | no | yes |

The cap counts OPEN work orders (draft, scheduled, in progress), not the ones you have ever
raised, so finishing a job frees its slot. So does `work_order_delete` on a draft that has
no lines, which is free on every tier: a way back that only a Pro key can reach is not a way
back.

Get Pro: https://mcp.zovo.one/buy/work-order (one-time $19, lifetime), or all servers for
$39: https://mcp.zovo.one/buy/bundle

## Where the money comes from

This server keeps no arithmetic of its own. `computeTotals`, `currencyDecimals`,
`formatMoney` and `roundHalfUp` are imported from `@theluckystrike/mcp-invoice/lib`, the A4
renderer from `@theluckystrike/mcp-billing-docs/lib`, the corrupt-store quarantine from
`@theluckystrike/mcp-timezone/lib`. The VAT rate, the currency and the business name come
from the shared business profile that `business_set` in the invoice server writes; the
client comes from that server's client records. Nothing is written outside this server's own
directory.

## The measured insight

**A markup belongs on the unit cost, not on the line total, and one minor unit is what says
so.** Seven parts at EUR 12.99 with 15 percent on top is EUR 14.94 a unit and EUR 104.58 on
the line. Marking up the line total instead is `round(9093 * 1.15)` = 10,457 minor units, a
cent less. Both look like the same sum, and only one of them is the figure the customer will
be billed: the invoice server rounds the unit price to the minor unit first and multiplies
(its D-R24 basis), so a work order that quotes the line-total figure quotes a number its own
invoice cannot reproduce. The gap appears on every line whose marked-up unit does not land on
a whole cent, it never nets out across lines because it is a rounding direction and not an
error, and it is invisible in a spreadsheet check because both bases add up correctly. The
unit suite asserts the 1-unit gap explicitly, so a change of basis fails the build instead of
quietly re-pricing every job on the board.

## Privacy

All data stays on your machine, in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/work-order/`.
Nothing is sent anywhere. There is no account and no API key. License keys are verified
offline. This server reads one sibling file, the invoice server's `clients.json`, and writes
into no store but its own.

Built by theluckystrike. https://github.com/theluckystrike
