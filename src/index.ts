#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import {
  currencyDecimals, findClient, formatMoney, getBusiness, hasBusiness, type Business,
} from "@theluckystrike/mcp-invoice/lib";
import { renderDocPdf } from "@theluckystrike/mcp-billing-docs/lib";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import {
  MAX_HOURS, MAX_LINES, MAX_MARKUP, MAX_MINOR, MAX_QUANTITY, MAX_ROWS, OPEN_STATUSES,
  PRIORITIES, STATUS_ORDER, hoursOf, isOpen, labourValueMinor, lineValueMinor,
  markedUpUnitMinor, netValueMinor, normaliseText, orderKey, partsCostMinor, partsValueMinor,
  payloadTotals, reachedAt, transitionError,
  type LabourLine, type Line, type PartsLine, type Party, type Priority, type Status, type WorkOrder,
} from "./order.js";
import { dataDir, getOrders, lockPath, nextId, nextLineId, resolveOrder, setOrders } from "./store.js";

/**
 * Free tier: FIVE open work orders, and the text completion report.
 *
 * What is metered is the size of the board, not the answer. A one-van trade runs a handful
 * of live jobs, and a free tier that withheld the completion report would withhold the one
 * document the customer signs. Closing a job frees its slot, so the cap is one you can get
 * back under without a key (docs/RECOVERABLE_SLOTS_RESULT.md).
 */
const FREE_OPEN_ORDERS = 5;
const MAX_NAME = 200;
const MAX_TEXT = 2000;

const gate = createLicenseGate({ product: "work-order" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));

const str = (field: string, max: number) => z.string().max(max, `${field} must be ${max} characters or fewer`);

/** Only this server's own store is written, so there is one lock and it is this one. */
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}

function checkDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new Error(`cannot read a date: ${field} "${value}" is not a real date in YYYY-MM-DD form. Nothing was written.`);
  return value;
}

function requirePro(feature: string, toolName: string): void {
  if (!gate.isPro()) throw new Error(`${feature} is Pro. Nothing was written. ${gate.upgradeText(feature, toolName)}`);
}

function expandPath(p: string): string {
  const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}

const money = (minor: number, currency: string) => formatMoney(minor, currency);

/** Minor units as a plain major-unit decimal string, for the invoice_create payload. */
function major(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  return (minor / 10 ** d).toFixed(d);
}

const BASIS =
  "No total is stored. The value, the hours, the materials and the VAT are derived on every call from the lines, so an edited line cannot leave a total behind that still says otherwise. " +
  "The markup goes on the unit cost, not on the line total, because that is the basis the invoice server rounds on; marking up the line total instead quotes a figure the invoice cannot reproduce.";

/* ---------------------------------------------------------- shared profile */

const profileCurrency = (): string => (readSharedProfile().default_currency ?? "EUR").toUpperCase();

/** VAT for the invoice payload. The profile's rate, or zero when it carries none. */
function profileTaxRate(): { rate: number; source: "shared profile" | "none" } {
  const r = readSharedProfile().default_tax_rate;
  return typeof r === "number" && Number.isFinite(r) ? { rate: r, source: "shared profile" } : { rate: 0, source: "none" };
}

/**
 * The default labour rate from the shared business profile, in minor units.
 *
 * MEASURED, and the reason `rate_minor` is refused by name rather than guessed: the shared
 * profile's field list (`PROFILE_FIELDS` in packages/mcp-license/src/profile.ts) carries a
 * default CURRENCY, a default TAX RATE and payment terms, but no default hourly rate, and
 * `readSharedProfile` drops every key outside that list. So this returns a rate only once
 * that package adds `default_rate_minor`; until then a labour line states its own rate and
 * the refusal says exactly which field would have filled it. Improvising a rate here would
 * put a number nobody typed onto an invoice.
 */
function profileRateMinor(): number | undefined {
  const v = (readSharedProfile() as Record<string, unknown>)["default_rate_minor"];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

const PLACEHOLDER_ISSUER = "Your business";

function issuer(): Business {
  const b = getBusiness();
  return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
}

const businessMissing = (): boolean => !hasBusiness() || !getBusiness().name.trim();

/* ------------------------------------------------------------------ shaping */

function lineJson(l: Line, currency: string) {
  const value = lineValueMinor(l);
  const base = { id: l.id, kind: l.kind, description: l.description, date: l.date ?? null, note: l.note ?? null, value: money(value, currency), value_minor: value };
  return l.kind === "labour"
    ? { ...base, hours: l.hours, rate: money(l.rate_minor, currency), rate_minor: l.rate_minor, rate_source: l.rate_source }
    : {
      ...base, quantity: l.quantity,
      unit_cost: money(l.unit_cost_minor, currency), unit_cost_minor: l.unit_cost_minor,
      markup_percent: l.markup_percent,
      billed_unit: money(markedUpUnitMinor(l), currency), billed_unit_minor: markedUpUnitMinor(l),
    };
}

function orderSummary(o: WorkOrder) {
  const net = netValueMinor(o);
  return {
    id: o.id, status: o.status, priority: o.priority,
    client: o.client.name, client_id: o.client_id, client_source: o.client_source,
    site_address: o.site_address, requested_date: o.requested_date,
    description: o.description, currency: o.currency,
    lines: o.lines.length, hours: hoursOf(o),
    labour_minor: labourValueMinor(o), materials_minor: partsValueMinor(o),
    net: money(net, o.currency), net_minor: net,
    open: isOpen(o),
    last_status_change: o.history.length ? o.history[o.history.length - 1].date : o.requested_date,
  };
}

function orderDetail(o: WorkOrder) {
  const tax = profileTaxRate();
  const t = payloadTotals(o, tax.rate);
  return {
    ...orderSummary(o),
    client_record: o.client,
    note: o.note ?? null,
    lines_detail: o.lines.map((l) => lineJson(l, o.currency)),
    parts_cost_minor: partsCostMinor(o),
    markup_earned_minor: partsValueMinor(o) - partsCostMinor(o),
    vat_rate: tax.rate, vat_rate_source: tax.source,
    vat: money(t.tax_minor, o.currency), vat_minor: t.tax_minor,
    gross: money(t.total_minor, o.currency), gross_minor: t.total_minor,
    history: o.history,
    created: o.created, updated: o.updated,
  };
}

function openCount(list: WorkOrder[]): number {
  return list.filter((o) => isOpen(o)).length;
}

/* ------------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-work-order", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const orderArg = str("work_order", MAX_NAME).describe("The work order id, e.g. WO-2026-0001, or the client name when only one job is theirs");

server.registerTool("work_order_create", {
  title: "Raise a work order",
  description: "Raise a job order and return its WO-YYYY-NNNN number: the client, the site address, the date it was asked for, what the job is and how urgent. Free tier: 5 open orders.",
  inputSchema: {
    client: str("client", MAX_NAME).describe("A client name or id from the invoice server's client records. An unknown name needs client_address as well, so a typo is not filed as a new customer"),
    site_address: str("site_address", MAX_TEXT).describe("Where the work happens. This is the site, not the billing address"),
    requested_date: str("requested_date", 10).describe("The date the work was asked for, YYYY-MM-DD"),
    description: str("description", MAX_TEXT).describe("What the job is, e.g. Replace immersion heater and test"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("How urgent the job is. Default normal"),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code such as EUR").optional().describe("ISO code the job is priced in. Defaults to the shared business profile's currency"),
    client_address: str("client_address", MAX_TEXT).optional().describe("The client's billing address, for a client that is not in the invoice records yet"),
    client_email: str("client_email", MAX_NAME).optional(),
    client_vat_id: str("client_vat_id", MAX_NAME).optional(),
    note: str("note", MAX_TEXT).optional(),
    duplicate_ok: z.boolean().optional().describe("Raise it even though an identical work order exists, for a genuinely repeated visit. Default false"),
  },
}, async (a) => {
  try {
    const requested = checkDate(a.requested_date, "requested_date");
    const currency = (a.currency ?? profileCurrency()).toUpperCase();
    const priority: Priority = a.priority ?? "normal";
    const description = normaliseText(a.description);
    const site = normaliseText(a.site_address);
    if (!description) throw new Error("description is empty. A work order with no description is a job nobody can be sent to do. Nothing was written.");
    if (!site) throw new Error("site_address is empty. Nothing was written.");

    const inline = a.client_address || a.client_email || a.client_vat_id;
    const record = findClient(a.client);
    let client: Party;
    let clientId: string | null;
    let source: "invoice client record" | "inline";
    if (record) {
      client = {
        name: record.name,
        address: a.client_address ?? record.address,
        email: a.client_email ?? record.email,
        vat_id: a.client_vat_id ?? record.vat_id,
      };
      clientId = record.id;
      source = "invoice client record";
    } else {
      if (!inline) {
        throw new Error(
          `no client record matches "${a.client}", and no address was given for a new one. A bare unknown name is a misspelling far more often than a new customer, ` +
          `and the invoice raised from this job would carry a BILL TO block with nothing in it. Either run client_add in the invoice server first, or pass client_address here. Nothing was written.`,
        );
      }
      client = { name: normaliseText(a.client), address: a.client_address, email: a.client_email, vat_id: a.client_vat_id };
      clientId = null;
      source = "inline";
    }

    const draft = { client, site_address: site, requested_date: requested, description, priority, currency };
    const rec = await locked(() => {
      const list = getOrders();
      // Duplicate BEFORE the cap: the refusal names an id rather than selling an upgrade,
      // and burns neither a slot nor a WO number.
      const key = orderKey(draft);
      const twin = list.find((o) => orderKey(o) === key);
      if (twin && !a.duplicate_ok) {
        throw new Error(
          `${twin.id} is already this work order: ${twin.client.name}, ${twin.site_address}, ${twin.requested_date}, "${twin.description}", ${twin.priority}. ` +
          `It is ${twin.status}. Nothing was written. If this really is a second visit, pass duplicate_ok true, or say what is different in the description.`,
        );
      }
      const open = openCount(list);
      if (!gate.isPro() && open >= FREE_OPEN_ORDERS) {
        throw new Error(
          `the free tier holds ${FREE_OPEN_ORDERS} open work orders and ${open} are open (${list.filter(isOpen).map((o) => `${o.id} ${o.status}`).join(", ")}). ` +
          `Closing a job frees its slot: work_order_status to done, or work_order_delete on a draft with no lines. Both stay free. Nothing was written. ` +
          gate.upgradeText("unlimited work orders", "work_order_create"),
        );
      }
      const id = nextId(requested.slice(0, 4), list.map((o) => o.id));
      const now = new Date().toISOString();
      const o: WorkOrder = {
        id, client_id: clientId, client, client_source: source,
        site_address: site, requested_date: requested, description, priority, currency,
        status: "draft", history: [], lines: [], note: a.note, created: now, updated: now,
      };
      list.push(o);
      setOrders(list);
      return { o, twin };
    });

    const notes: string[] = [];
    if (rec.o.client_source === "inline") {
      notes.push(`"${rec.o.client.name}" is not in the invoice client records, so this job carries its own copy of the details. Run client_add in the invoice server to make it a record every later job and invoice shares.`);
    }
    if (rec.twin) notes.push(`${rec.twin.id} is an identical work order and was allowed through because duplicate_ok was passed.`);
    if (!gate.isPro()) notes.push(`Free tier: ${openCount(getOrders())} of ${FREE_OPEN_ORDERS} open work orders. completion_report_pdf, work_order_invoice_payload and work_orders_report are Pro.`);
    return json({
      created: orderDetail(rec.o),
      next: `Add what the job used with work_order_add_line, then move it along with work_order_status: ${STATUS_ORDER.join(" to ")}.`,
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("work_order_add_line", {
  title: "Add a parts or labour line",
  description: "Add one line: parts with quantity, unit_cost_minor in whole MINOR units and optional markup, or labour with hours and rate_minor. A line on an invoiced order, or dated before the request, is refused.",
  inputSchema: {
    work_order: orderArg,
    kind: z.enum(["parts", "labour"]).describe("parts for materials, labour for time on the job"),
    description: str("description", MAX_TEXT).describe("What it is, e.g. 3kW immersion element, or Second fix and test"),
    quantity: z.number().finite().positive().max(MAX_QUANTITY).optional().describe("parts only: how many. A negative or zero quantity is refused"),
    unit_cost_minor: z.number().int().min(0).max(MAX_MINOR).optional().describe("parts only: what one costs YOU, in whole minor units. 1299 is EUR 12.99"),
    markup_percent: z.number().finite().min(0).max(MAX_MARKUP).optional().describe("parts only: percent added to the UNIT cost before billing. Default 0"),
    hours: z.number().finite().positive().max(MAX_HOURS).optional().describe("labour only: hours worked, e.g. 3.5"),
    rate_minor: z.number().int().min(0).max(MAX_MINOR).optional().describe("labour only: the hourly rate in whole minor units. Omit only once the shared business profile carries a default rate"),
    date: str("date", 10).optional().describe("The day this line was worked or fitted, YYYY-MM-DD"),
    note: str("note", MAX_TEXT).optional(),
  },
}, async (a) => {
  try {
    const date = a.date ? checkDate(a.date, "date") : undefined;
    const description = normaliseText(a.description);
    if (!description) throw new Error("description is empty. A line an invoice cannot describe is a line the customer will query. Nothing was written.");
    const out = await locked(() => {
      const list = getOrders();
      const o = resolveOrder(list, a.work_order);
      if (o.status === "invoiced") {
        throw new Error(`${o.id} was invoiced on ${reachedAt(o, "invoiced")?.date}. Adding a line now would change a job the customer has already been billed for. Raise a second work order for the extra work. Nothing was written.`);
      }
      if (o.lines.length >= MAX_LINES) throw new Error(`${o.id} already carries ${MAX_LINES} lines, which is the ceiling. Nothing was written.`);
      if (date && date < o.requested_date) {
        throw new Error(`${o.id} was requested on ${o.requested_date} and this line is dated ${date}. Work cannot have been done before the job was asked for. Nothing was written.`);
      }
      const now = new Date().toISOString();
      let line: Line;
      if (a.kind === "parts") {
        if (a.quantity === undefined) throw new Error("a parts line needs quantity. Nothing was written.");
        if (a.unit_cost_minor === undefined) throw new Error("a parts line needs unit_cost_minor, the cost of ONE, in whole minor units. Nothing was written.");
        if (a.hours !== undefined || a.rate_minor !== undefined) throw new Error("hours and rate_minor belong to a labour line. Nothing was written.");
        const l: PartsLine = {
          id: nextLineId(o), kind: "parts", description,
          quantity: a.quantity, unit_cost_minor: a.unit_cost_minor,
          markup_percent: a.markup_percent ?? 0, date, note: a.note, created: now,
        };
        line = l;
      } else {
        if (a.hours === undefined) throw new Error("a labour line needs hours. Nothing was written.");
        if (a.quantity !== undefined || a.unit_cost_minor !== undefined || a.markup_percent !== undefined) {
          throw new Error("quantity, unit_cost_minor and markup_percent belong to a parts line. Nothing was written.");
        }
        const fromProfile = profileRateMinor();
        const rate = a.rate_minor ?? fromProfile;
        if (rate === undefined) {
          throw new Error(
            "a labour line needs rate_minor, the hourly rate in whole minor units, and the shared business profile carries no default rate to fall back on. " +
            "The profile's field list (default_currency, default_tax_rate, payment_terms_days and the identity fields) has no rate field today, so nothing here can supply one, " +
            "and a rate this server invented would end up on an invoice nobody typed it into. Pass rate_minor. Nothing was written.",
          );
        }
        const l: LabourLine = {
          id: nextLineId(o), kind: "labour", description, hours: a.hours,
          rate_minor: rate, rate_source: a.rate_minor === undefined ? "shared profile" : "call",
          date, note: a.note, created: now,
        };
        line = l;
      }
      o.lines.push(line);
      o.updated = now;
      setOrders(list);
      return { o, line };
    });
    const notes: string[] = [];
    if (out.line.kind === "parts" && out.line.markup_percent > 0) {
      notes.push(
        `The ${out.line.markup_percent}% markup goes on the UNIT cost: ${money(out.line.unit_cost_minor, out.o.currency)} becomes ` +
        `${money(markedUpUnitMinor(out.line), out.o.currency)} a unit, and the line is ${out.line.quantity} of those. ` +
        `That is the basis the invoice server rounds on, so this line total and the invoice line agree to the minor unit.`,
      );
    }
    if (out.o.status === "done") notes.push(`${out.o.id} is already done. The line was added, and any completion report already given to the customer is now out of date.`);
    return json({
      added: lineJson(out.line, out.o.currency),
      work_order: orderSummary(out.o),
      notes, basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("work_order_status", {
  title: "Move a work order along",
  description: "Move one work order exactly one step: draft, scheduled, in_progress, done, invoiced, stamping date and note. A skipped, backwards or backdated step is refused and nothing is written. Free.",
  inputSchema: {
    work_order: orderArg,
    status: z.enum(["draft", "scheduled", "in_progress", "done", "invoiced"]).describe("The status to move to. It must be the next one along"),
    date: str("date", 10).optional().describe("The day it reached this status, YYYY-MM-DD. Default today"),
    note: str("note", MAX_TEXT).optional().describe("What happened, e.g. Booked for Tuesday morning, or Signed off by the tenant"),
  },
}, async (a) => {
  try {
    const date = a.date ? checkDate(a.date, "date") : today();
    const out = await locked(() => {
      const list = getOrders();
      const o = resolveOrder(list, a.work_order);
      const why = transitionError(o.status, a.status as Status);
      if (why) throw new Error(`${o.id} ${why}. Nothing was written.`);
      if (date < o.requested_date) {
        throw new Error(`${o.id} was requested on ${o.requested_date} and this status change is dated ${date}. Nothing was written.`);
      }
      const last = o.history.length ? o.history[o.history.length - 1] : null;
      if (last && date < last.date) {
        throw new Error(`${o.id} reached ${last.to} on ${last.date} and this change is dated ${date}, before it. A status history that runs backwards cannot be read as a timeline. Nothing was written.`);
      }
      const now = new Date().toISOString();
      const event = { from: o.status, to: a.status as Status, date, note: a.note, at: now };
      o.history.push(event);
      o.status = a.status as Status;
      o.updated = now;
      setOrders(list);
      return { o, event, list };
    });
    const notes: string[] = [];
    if (out.event.to === "done" && !out.o.lines.length) {
      notes.push(`${out.o.id} was marked done with no lines, so its completion report has nothing on it and the invoice payload would be empty. Add what the job used with work_order_add_line.`);
    }
    if (out.event.to === "done") notes.push("Give the customer completion_report_text or completion_report_pdf to sign, then work_order_invoice_payload for the invoice.");
    if (out.event.to === "invoiced") {
      notes.push("Marking a work order invoiced records that YOU raised the invoice in the invoice server. This server creates no invoice and marks nothing there; work_order_invoice_payload only hands you the arguments.");
    }
    if (!isOpen(out.o) && !gate.isPro()) {
      notes.push(`Free tier: ${openCount(out.list)} of ${FREE_OPEN_ORDERS} open work orders. Closing this one gave a slot back.`);
    }
    return json({ work_order: orderSummary(out.o), moved: out.event, history: out.o.history, notes, basis: BASIS });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("work_order_get", {
  title: "Show one work order",
  description: "Return one work order in full by WO number or client: the site, every parts and labour line with the unit billed, hours, materials, net and VAT, and the status history. Reads only. Free.",
  inputSchema: { work_order: orderArg },
}, async (a) => {
  try {
    return json({ work_order: orderDetail(resolveOrder(getOrders(), a.work_order)), basis: BASIS });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("work_order_list", {
  title: "List work orders",
  description: "List work orders newest requested first: status, priority, client, site, hours, labour, materials and net value, with totals per currency. Filter by status, client and requested-date range. Free.",
  inputSchema: {
    status: z.enum(["draft", "scheduled", "in_progress", "done", "invoiced", "open"]).optional().describe("One status, or open for draft, scheduled and in_progress together"),
    client: str("client", MAX_NAME).optional().describe("Only jobs whose client name contains this text"),
    from: str("from", 10).optional().describe("Earliest requested_date, YYYY-MM-DD"),
    to: str("to", 10).optional().describe("Latest requested_date, YYYY-MM-DD"),
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum rows returned, default and ceiling ${MAX_ROWS}`),
  },
}, async (a) => {
  try {
    if (a.from) checkDate(a.from, "from");
    if (a.to) checkDate(a.to, "to");
    if (a.from && a.to && a.from > a.to) throw new Error(`from ${a.from} is after to ${a.to}, so the range is empty.`);
    let list = getOrders();
    if (a.status === "open") list = list.filter((o) => isOpen(o));
    else if (a.status) list = list.filter((o) => o.status === a.status);
    if (a.client) {
      const needle = a.client.trim().toLowerCase();
      list = list.filter((o) => o.client.name.toLowerCase().includes(needle));
    }
    if (a.from) list = list.filter((o) => o.requested_date >= a.from!);
    if (a.to) list = list.filter((o) => o.requested_date <= a.to!);
    const sorted = [...list].sort((x, y) => y.requested_date.localeCompare(x.requested_date) || y.id.localeCompare(x.id));
    const limit = a.limit ?? MAX_ROWS;
    const byCurrency = new Map<string, { currency: string; orders: number; hours: number; net_minor: number }>();
    for (const o of sorted) {
      const t = byCurrency.get(o.currency) ?? { currency: o.currency, orders: 0, hours: 0, net_minor: 0 };
      t.orders += 1; t.hours += hoursOf(o); t.net_minor += netValueMinor(o);
      byCurrency.set(o.currency, t);
    }
    return json({
      count: sorted.length,
      truncated: sorted.length > limit,
      totals: [...byCurrency.values()].sort((x, y) => x.currency.localeCompare(y.currency))
        .map((t) => ({ ...t, hours: Number(t.hours.toFixed(4)), net: money(t.net_minor, t.currency) })),
      work_orders: sorted.slice(0, limit).map(orderSummary),
      note: "Currencies are never added together. This server holds no exchange rate, so one value over a EUR job and a PLN one would be an invented number.",
    });
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("work_order_delete", {
  title: "Delete a draft work order",
  description: "Delete a DRAFT work order with no lines, freeing an open slot. One past draft is refused, naming the date it got there, and so is one carrying lines. The WO number is never reissued. work_order_status moves it on.",
  inputSchema: { work_order: orderArg },
}, async (a) => {
  try {
    const out = await locked(() => {
      const list = getOrders();
      const o = resolveOrder(list, a.work_order);
      if (o.status !== "draft") {
        throw new Error(
          `${o.id} is ${o.status}, not draft, so it cannot be deleted. It reached ${o.status} on ${reachedAt(o, o.status)?.date}, and that is a fact about a job somebody did. ` +
          `Nothing was written.`,
        );
      }
      if (o.lines.length) {
        throw new Error(
          `${o.id} carries ${o.lines.length} line(s) worth ${money(netValueMinor(o), o.currency)} (${o.lines.map((l) => l.id).join(", ")}) and cannot be deleted. ` +
          `Parts and hours on a job are a record of what was used. Nothing was written.`,
        );
      }
      const rest = list.filter((x) => x.id !== o.id);
      setOrders(rest);
      return { o, rest };
    });
    return json({
      deleted: orderSummary(out.o),
      open_work_orders: openCount(out.rest),
      free_tier_open_limit: gate.isPro() ? null : FREE_OPEN_ORDERS,
      note: "The number is not reissued. The WO series only ever goes up, so a gap in it is the record that a work order was deleted.",
    });
  } catch (e) { return fail((e as Error).message); }
});

/* -------------------------------------------------------- completion report */

function reportRows(o: WorkOrder): { labour: LabourLine[]; parts: PartsLine[] } {
  return {
    labour: o.lines.filter((l): l is LabourLine => l.kind === "labour"),
    parts: o.lines.filter((l): l is PartsLine => l.kind === "parts"),
  };
}

const SIGN_OFF = [
  "Work completed by ......................................  Date ..................",
  "Received and accepted by ...............................  Date ..................",
];

function reportText(o: WorkOrder): string {
  const tax = profileTaxRate();
  const t = payloadTotals(o, tax.rate);
  const { labour, parts } = reportRows(o);
  const biz = issuer();
  const done = reachedAt(o, "done");
  const out: string[] = [];
  out.push("COMPLETION REPORT");
  out.push(o.id);
  out.push("");
  out.push(`${biz.name}`);
  if (biz.address) out.push(biz.address);
  out.push("");
  out.push(`Client        ${o.client.name}`);
  out.push(`Site          ${o.site_address}`);
  out.push(`Requested     ${o.requested_date}`);
  out.push(`Completed     ${done ? done.date : "not marked done yet"}`);
  out.push(`Status        ${o.status}`);
  out.push(`Priority      ${o.priority}`);
  out.push("");
  out.push("WORK CARRIED OUT");
  out.push(`  ${o.description}`);
  out.push("");
  out.push("LABOUR");
  if (!labour.length) out.push("  none recorded");
  for (const l of labour) {
    out.push(`  ${l.date ?? o.requested_date}  ${l.description}  ${l.hours} h at ${money(l.rate_minor, o.currency)}/h  ${money(lineValueMinor(l), o.currency)}`);
  }
  out.push(`  Hours ${Number(hoursOf(o).toFixed(4))}, labour ${money(labourValueMinor(o), o.currency)}`);
  out.push("");
  out.push("MATERIALS");
  if (!parts.length) out.push("  none recorded");
  for (const l of parts) {
    out.push(`  ${l.date ?? o.requested_date}  ${l.description}  ${l.quantity} x ${money(markedUpUnitMinor(l), o.currency)}  ${money(lineValueMinor(l), o.currency)}`);
  }
  out.push(`  Materials ${money(partsValueMinor(o), o.currency)}`);
  out.push("");
  out.push(`  Net    ${money(t.net_minor, o.currency)}`);
  for (const line of t.tax_lines) {
    if (!line.rate && !line.tax_minor) continue;
    out.push(`  VAT ${line.rate}% on ${money(line.base_minor, o.currency)}  ${money(line.tax_minor, o.currency)}`);
  }
  out.push(`  Total  ${money(t.total_minor, o.currency)}`);
  out.push("");
  out.push("SIGN-OFF");
  for (const s of SIGN_OFF) out.push(`  ${s}`);
  if (o.note) { out.push(""); out.push("NOTES"); out.push(`  ${o.note}`); }
  return out.join("\n");
}

server.registerTool("completion_report_text", {
  title: "Completion report as plain text",
  description: "Turn a work order into a plain-text completion report: what was done, the labour hours, the materials, the totals and a sign-off block, ready to paste into an email. Free on every tier.",
  inputSchema: { work_order: orderArg },
}, async (a) => {
  try {
    const o = resolveOrder(getOrders(), a.work_order);
    const notes: string[] = [];
    if (o.status !== "done" && o.status !== "invoiced") {
      notes.push(`${o.id} is ${o.status}, not done. This report is what the job stands at now, not what it finished at.`);
    }
    if (businessMissing()) notes.push(`No business profile yet, so the report is headed "${PLACEHOLDER_ISSUER}". Run business_set {name, address} in the invoice server once.`);
    return ok(`${reportText(o)}\n\n${notes.length ? `${notes.join("\n")}\n\n` : ""}${JSON.stringify({ work_order: o.id, hours: hoursOf(o), materials_minor: partsValueMinor(o), net_minor: netValueMinor(o) }, null, 2)}`);
  } catch (e) { return fail((e as Error).message); }
});

server.registerTool("completion_report_pdf", {
  title: "Completion report as a PDF",
  description: "Call this tool to write the A4 completion report of one work order and return the file path: the lines, the hours, the materials, the totals and the sign-off block. Pro.",
  inputSchema: {
    work_order: orderArg,
    out_path: z.string().max(1000).optional().describe("Where to write the file. Defaults to the work-order data directory under pdf/"),
  },
}, async (a) => {
  try {
    requirePro("the completion report PDF", "completion_report_pdf");
    const o = resolveOrder(getOrders(), a.work_order);
    const tax = profileTaxRate();
    const t = payloadTotals(o, tax.rate);
    const done = reachedAt(o, "done");
    const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `${o.id}.pdf`);
    await renderDocPdf({
      title: "COMPLETION REPORT",
      number: o.id,
      reference: `site ${o.site_address}`,
      party_label: "WORK FOR",
      party: o.client,
      meta: [
        ["Requested", o.requested_date],
        ["Completed", done ? done.date : "not marked done"],
        ["Status", o.status],
        ["Priority", o.priority],
      ],
      currency: o.currency,
      lines: t.lines,
      subtotal_minor: t.subtotal_minor,
      discount_percent: t.discount_percent,
      discount_minor: t.discount_minor,
      net_minor: t.net_minor,
      tax_lines: t.tax_lines,
      total_minor: t.total_minor,
      footer_label: "SIGN-OFF",
      footer_lines: [
        o.description,
        `Hours ${Number(hoursOf(o).toFixed(4))}. Materials ${money(partsValueMinor(o), o.currency)}.`,
        ...SIGN_OFF,
      ],
      notes: o.note,
      product: "mcp-work-order",
    }, issuer(), out, { branded: !gate.isPro(), logo: gate.isPro() });
    return json({
      work_order: o.id, path: out,
      document: /\.html?$/i.test(out) ? "HTML completion report (print to PDF)" : "PDF completion report",
      hours: hoursOf(o),
      materials: money(partsValueMinor(o), o.currency),
      total: money(t.total_minor, o.currency), total_minor: t.total_minor,
      notes: businessMissing() ? [`No business profile yet, so the report is headed "${PLACEHOLDER_ISSUER}". Run business_set in the invoice server.`] : undefined,
    });
  } catch (e) { return fail((e as Error).message); }
});

/* ----------------------------------------------------------- invoice payload */

server.registerTool("work_order_invoice_payload", {
  title: "Invoice payload for a work order",
  description: "Build an invoice_create-ready payload from the lines, with VAT at the shared profile rate. Writes nothing and marks nothing: raise the invoice in the invoice server, then set this order invoiced. Pro.",
  inputSchema: {
    work_order: orderArg,
    issue_date: str("issue_date", 10).optional().describe("The invoice issue date, YYYY-MM-DD. Default today"),
    tax_rate: z.number().finite().min(-100).max(1000).optional().describe("VAT percent per line, overriding the shared business profile's default rate"),
  },
}, async (a) => {
  try {
    requirePro("the invoice payload", "work_order_invoice_payload");
    const issue = a.issue_date ? checkDate(a.issue_date, "issue_date") : today();
    const o = resolveOrder(getOrders(), a.work_order);
    if (!o.lines.length) {
      throw new Error(`${o.id} has no lines, so there is nothing to invoice. Add the hours and the parts with work_order_add_line first.`);
    }
    if (o.status === "invoiced") {
      throw new Error(`${o.id} was already marked invoiced on ${reachedAt(o, "invoiced")?.date}. Raising a second invoice from it would bill the customer twice. Check the invoice server before overriding this.`);
    }
    const profile = profileTaxRate();
    const rate = a.tax_rate ?? profile.rate;
    const source = a.tax_rate === undefined ? profile.source : "call";
    const t = payloadTotals(o, rate);
    const items = t.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: Number(major(l.unit_price_minor, o.currency)),
      tax_rate: l.tax_rate,
    }));
    const notes: string[] = [];
    if (o.status !== "done") {
      notes.push(`${o.id} is ${o.status}, not done. Invoicing a job that is not finished bills for hours that are still being worked.`);
    }
    if (source === "none") {
      notes.push("The shared business profile carries no default_tax_rate, so VAT is 0% here. Run business_set {default_tax_rate} in the invoice server, or pass tax_rate.");
    }
    return json({
      work_order: o.id, status: o.status, currency: o.currency,
      vat_rate: rate, vat_rate_source: source,
      invoice_create: {
        tool: "invoice_create",
        server: "invoice",
        arguments: {
          client: o.client_id ?? o.client.name,
          currency: o.currency,
          issue_date: issue,
          items,
          notes: `Work order ${o.id}: ${o.description}. Site: ${o.site_address}.`,
        },
      },
      totals: {
        subtotal: money(t.subtotal_minor, o.currency), subtotal_minor: t.subtotal_minor,
        net: money(t.net_minor, o.currency), net_minor: t.net_minor,
        tax_lines: t.tax_lines,
        vat: money(t.tax_minor, o.currency), vat_minor: t.tax_minor,
        total: money(t.total_minor, o.currency), total_minor: t.total_minor,
      },
      hours: hoursOf(o),
      labour_minor: labourValueMinor(o),
      materials_minor: partsValueMinor(o),
      parts_cost_minor: partsCostMinor(o),
      markup_earned_minor: partsValueMinor(o) - partsCostMinor(o),
      posted: false,
      marked_invoiced: false,
      note: "Nothing was written and nothing was marked. Call invoice_create in the invoice server with the arguments above, then work_order_status {status: \"invoiced\"} here once the invoice exists.",
      basis:
        "Every unit_price above is already the billed unit in major units, so invoice_create's own computeTotals reproduces these totals to the minor unit. " +
        "A parts line carries the marked-up unit, never the bare cost with a discount and never the line total as a quantity of one; both of those round differently.",
      notes,
    });
  } catch (e) { return fail((e as Error).message); }
});

/* ------------------------------------------------------------------- report */

server.registerTool("work_orders_report", {
  title: "Report the board",
  description: "Report the whole board: how many work orders sit at each status, the hours logged this month, and the value not yet invoiced per currency, with the oldest open jobs named. Pro.",
  inputSchema: {
    month: str("month", 7).optional().describe("The month for the hours figure, YYYY-MM. Default the current month"),
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum oldest-open rows listed, default and ceiling ${MAX_ROWS}`),
  },
}, async (a) => {
  try {
    requirePro("the board report", "work_orders_report");
    const month = a.month ?? today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month "${month}" is not YYYY-MM.`);
    const list = getOrders();
    const limit = a.limit ?? MAX_ROWS;

    const byStatus = STATUS_ORDER.map((s) => ({
      status: s, open: OPEN_STATUSES.includes(s),
      count: list.filter((o) => o.status === s).length,
    }));

    // Hours are counted on the LINE date, not the order date: a job requested in March and
    // worked in April logged its hours in April, and a month that counted by order date
    // would move a whole visit into the month the phone rang.
    let hoursThisMonth = 0;
    const hoursByOrder: { id: string; hours: number }[] = [];
    for (const o of list) {
      let h = 0;
      for (const l of o.lines) {
        if (l.kind !== "labour") continue;
        const d = l.date ?? o.requested_date;
        if (d.slice(0, 7) === month) h += l.hours;
      }
      if (h) { hoursThisMonth += h; hoursByOrder.push({ id: o.id, hours: Number(h.toFixed(4)) }); }
    }

    // Unbilled: everything that is not yet marked invoiced, whatever its status, because
    // that is the money the business has done work for and not yet asked for.
    const unbilled = list.filter((o) => o.status !== "invoiced");
    const byCurrency = new Map<string, { currency: string; work_orders: number; hours: number; labour_minor: number; materials_minor: number; unbilled_minor: number }>();
    for (const o of unbilled) {
      const t = byCurrency.get(o.currency) ?? { currency: o.currency, work_orders: 0, hours: 0, labour_minor: 0, materials_minor: 0, unbilled_minor: 0 };
      t.work_orders += 1; t.hours += hoursOf(o);
      t.labour_minor += labourValueMinor(o); t.materials_minor += partsValueMinor(o);
      t.unbilled_minor += netValueMinor(o);
      byCurrency.set(o.currency, t);
    }

    const open = list.filter((o) => isOpen(o))
      .sort((x, y) => x.requested_date.localeCompare(y.requested_date) || x.id.localeCompare(y.id));

    return json({
      work_orders: list.length,
      by_status: byStatus,
      open: open.length,
      free_tier_open_limit: gate.isPro() ? null : FREE_OPEN_ORDERS,
      month,
      hours_this_month: Number(hoursThisMonth.toFixed(4)),
      hours_this_month_by_order: hoursByOrder.sort((x, y) => y.hours - x.hours || x.id.localeCompare(y.id)),
      unbilled_by_currency: [...byCurrency.values()].sort((x, y) => x.currency.localeCompare(y.currency))
        .map((t) => ({
          ...t, hours: Number(t.hours.toFixed(4)),
          labour: money(t.labour_minor, t.currency),
          materials: money(t.materials_minor, t.currency),
          unbilled: money(t.unbilled_minor, t.currency),
        })),
      oldest_open: open.slice(0, limit).map(orderSummary),
      oldest_open_truncated: open.length > limit,
      note: "Hours are counted on the line date, not on the date the job was requested, so a February call worked in March counts in March. Currencies are never added together.",
      basis: BASIS,
    });
  } catch (e) { return fail((e as Error).message); }
});

gate.registerTools(server);

/* ------------------------------------------------------- resource and prompt */

server.registerResource("board", "workorder://board", {
  title: "The status machine, the free tier and where this server writes",
  description: "The five statuses in order, the free-tier limits, the one directory this server writes and the one sibling store it reads.",
  mimeType: "application/json",
}, async () => ({
  contents: [{
    uri: "workorder://board", mimeType: "application/json",
    text: JSON.stringify({
      statuses: STATUS_ORDER,
      open_statuses: OPEN_STATUSES,
      priorities: PRIORITIES,
      transitions: "one step forward at a time; a skipped or backwards step is refused by name",
      free_tier: {
        open_work_orders: FREE_OPEN_ORDERS,
        free_tools: ["work_order_create", "work_order_add_line", "work_order_status", "work_order_get", "work_order_list", "work_order_delete", "completion_report_text"],
        pro_tools: ["completion_report_pdf", "work_order_invoice_payload", "work_orders_report"],
      },
      writes: [{ store: "work-order", dir: dataDir(), files: ["orders.json", "counter.json", "pdf/"] }],
      reads: [{ store: "invoice", file: "clients.json", why: "so a job carries the same client record the invoice will be raised against", writes: false }],
      creates_invoices: false,
      today: today(),
    }, null, 2),
  }],
}));

server.registerPrompt("close_the_job", {
  title: "Close a work order and bill it",
  description: "Record what the job used, mark it done, give the customer the completion report, and build the invoice payload.",
  argsSchema: { work_order: z.string().describe("The work order id, e.g. WO-2026-0001") },
}, ({ work_order }) => ({
  messages: [{
    role: "user" as const,
    content: {
      type: "text" as const,
      text: `Close work order ${work_order}.\n\n` +
        `1. Call work_order_add_line for every hour worked (kind labour, hours and rate_minor) and every part fitted (kind parts, quantity, unit_cost_minor, and markup_percent if you mark parts up). Costs are whole minor units.\n` +
        `2. Call work_order_status with status done and the day the work finished. The step before done is in_progress; the machine will not let you skip it.\n` +
        `3. Call completion_report_text (or completion_report_pdf) and give it to the customer to sign.\n` +
        `4. Call work_order_invoice_payload. Pass its arguments straight to invoice_create in the invoice server; do not retype or re-total them, the unit prices are already the billed units.\n` +
        `5. Once that invoice exists, call work_order_status with status invoiced. This server never creates an invoice and never marks one.`,
    },
  }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-work-order ${VERSION} ready; store at ${dataDir()}\n`);
