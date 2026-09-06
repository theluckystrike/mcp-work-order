import { computeTotals, currencyDecimals, roundHalfUp, type InputItem, type Totals } from "@theluckystrike/mcp-invoice/lib";

/**
 * The work order engine: the record shapes, the status machine and the money.
 *
 * Nothing here reads a file, a licence or the network, so every figure below is
 * reproducible from its arguments alone and the unit suite recomputes each one by hand.
 *
 * THE MARKUP IS APPLIED TO THE UNIT COST, NEVER TO THE LINE TOTAL. Under the invoice
 * server's rounding contract (D-R24, servers/invoice/src/money.ts) a line's gross is
 * `roundHalfUp(quantity * roundHalfUp(unit_price * 10^d))`: the unit is rounded to the
 * minor unit FIRST and the line is computed from that. A work order that marked up the
 * line total instead would quote a figure the invoice cannot reproduce. Seven parts at
 * 1299 with 15 percent on top is 1494 a unit and 10,458 on the line; marking up the line
 * total is `roundHalfUp(9093 * 1.15)` = 10,457. One minor unit, on every line whose
 * marked-up unit does not land on a whole cent, and it is always the invoice that wins,
 * because the invoice is the document the customer pays from.
 */

export const MAX_MINOR = 1e12;
export const MAX_HOURS = 100_000;
export const MAX_QUANTITY = 1_000_000;
export const MAX_LINES = 200;
export const MAX_ROWS = 500;
export const MAX_MARKUP = 1000;

export type Status = "draft" | "scheduled" | "in_progress" | "done" | "invoiced";

/** The status machine, in order. A status only ever moves one step along it. */
export const STATUS_ORDER: Status[] = ["draft", "scheduled", "in_progress", "done", "invoiced"];

/** Open means the job is not finished: it is these three, and the free cap counts them. */
export const OPEN_STATUSES: Status[] = ["draft", "scheduled", "in_progress"];

export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

export interface Party {
  name: string;
  address?: string;
  email?: string;
  vat_id?: string;
}

export interface PartsLine {
  id: string;
  kind: "parts";
  description: string;
  quantity: number;
  unit_cost_minor: number;
  markup_percent: number;
  date?: string;
  note?: string;
  created: string;
}

export interface LabourLine {
  id: string;
  kind: "labour";
  description: string;
  hours: number;
  rate_minor: number;
  rate_source: "call" | "shared profile";
  date?: string;
  note?: string;
  created: string;
}

export type Line = PartsLine | LabourLine;

export interface StatusEvent {
  from: Status;
  to: Status;
  date: string;
  note?: string;
  at: string;
}

export interface WorkOrder {
  id: string;
  client_id: string | null;
  client: Party;
  client_source: "invoice client record" | "inline";
  site_address: string;
  requested_date: string;
  description: string;
  priority: Priority;
  currency: string;
  status: Status;
  history: StatusEvent[];
  lines: Line[];
  note?: string;
  created: string;
  updated: string;
}

/* --------------------------------------------------------------------- money */

/** The unit a parts line is billed at: the cost with its markup, rounded to the minor unit. */
export function markedUpUnitMinor(l: PartsLine): number {
  return roundHalfUp(l.unit_cost_minor * (1 + l.markup_percent / 100));
}

/** What one line is worth, on exactly the basis `computeTotals` will use on the invoice. */
export function lineValueMinor(l: Line): number {
  return l.kind === "labour"
    ? roundHalfUp(l.hours * l.rate_minor)
    : roundHalfUp(l.quantity * markedUpUnitMinor(l));
}

/** What one parts line cost before the markup. Labour has no cost side here. */
export function lineCostMinor(l: Line): number {
  return l.kind === "labour" ? 0 : roundHalfUp(l.quantity * l.unit_cost_minor);
}

export const hoursOf = (o: WorkOrder): number =>
  o.lines.reduce((a, l) => a + (l.kind === "labour" ? l.hours : 0), 0);

export const labourValueMinor = (o: WorkOrder): number =>
  o.lines.reduce((a, l) => a + (l.kind === "labour" ? lineValueMinor(l) : 0), 0);

export const partsValueMinor = (o: WorkOrder): number =>
  o.lines.reduce((a, l) => a + (l.kind === "parts" ? lineValueMinor(l) : 0), 0);

export const partsCostMinor = (o: WorkOrder): number =>
  o.lines.reduce((a, l) => a + lineCostMinor(l), 0);

/** The net value of the job, before VAT. Never stored: derived from the lines every time. */
export const netValueMinor = (o: WorkOrder): number =>
  o.lines.reduce((a, l) => a + lineValueMinor(l), 0);

/**
 * The `invoice_create` items for a work order, in the argument shape that tool takes:
 * `unit_price` in MAJOR units, `quantity` the hours or the count.
 *
 * A parts line's `unit_price` is the MARKED-UP unit expressed exactly in major units, so
 * `computeTotals` rounds it straight back to the same integer and the invoice's line gross
 * equals `lineValueMinor` to the minor unit. Passing the bare cost and a discount, or the
 * line total as a quantity of one, both break that identity.
 */
export function invoiceItems(o: WorkOrder, taxRate: number): InputItem[] {
  const d = currencyDecimals(o.currency);
  const f = 10 ** d;
  return o.lines.map((l) => {
    if (l.kind === "labour") {
      return {
        description: `${l.description} (${l.hours} h at ${(l.rate_minor / f).toFixed(d)} ${o.currency}/h)`,
        quantity: l.hours,
        unit_price: l.rate_minor / f,
        tax_rate: taxRate,
      };
    }
    const unit = markedUpUnitMinor(l);
    return {
      description: l.markup_percent
        ? `${l.description} (${l.markup_percent}% on cost)`
        : l.description,
      quantity: l.quantity,
      unit_price: unit / f,
      tax_rate: taxRate,
    };
  });
}

/** The totals the invoice server will compute from those items. Same function, no copy. */
export function payloadTotals(o: WorkOrder, taxRate: number): Totals {
  return computeTotals(invoiceItems(o, taxRate), o.currency, 0, taxRate);
}

/* -------------------------------------------------------------------- status */

export function statusIndex(s: Status): number {
  return STATUS_ORDER.indexOf(s);
}

export const isOpen = (o: WorkOrder): boolean => OPEN_STATUSES.includes(o.status);

/**
 * Why a move from `from` to `to` is refused, or null when it is legal.
 *
 * The machine is one step forward at a time and nothing else. A job that jumped from
 * scheduled to invoiced was never marked done, so no completion report was ever produced
 * and no timestamp says when the work finished; a job moved backwards would have a history
 * that contradicts itself. Both are refused by name, with the step that IS next.
 */
export function transitionError(from: Status, to: Status): string | null {
  if (from === to) return `is already ${from}`;
  const i = statusIndex(from);
  const j = statusIndex(to);
  if (j < i) {
    return `is ${from} and ${to} is behind it. A work order only moves forward: ${STATUS_ORDER.join(" to ")}. ` +
      `A job that has to go back is a new work order, so the history of the first one stays true`;
  }
  if (j > i + 1) {
    return `is ${from}, and the next status is ${STATUS_ORDER[i + 1]}, not ${to}. ` +
      `Every step is recorded with its own timestamp, so skipping one loses the day the job actually reached it`;
  }
  return null;
}

/** The instant a work order first reached a status, or null if it never has. */
export function reachedAt(o: WorkOrder, s: Status): StatusEvent | null {
  return o.history.find((h) => h.to === s) ?? null;
}

/* ---------------------------------------------------------------- duplicates */

/**
 * The identity of a work order for duplicate refusal: everything a person types when they
 * raise one. Two jobs for one client at one address on one day with one description and one
 * priority are one job entered twice far more often than they are two visits.
 * Checked BEFORE the free cap, so the refusal names an id rather than selling an upgrade,
 * and burns neither a slot nor a WO number (docs/RECOVERABLE_SLOTS_RESULT.md).
 */
export function orderKey(o: {
  client: Party; site_address: string; requested_date: string; description: string;
  priority: Priority; currency: string;
}): string {
  return JSON.stringify([
    o.client.name.trim().toLowerCase(),
    o.site_address.trim().toLowerCase().replace(/\s+/g, " "),
    o.requested_date,
    o.description.trim().toLowerCase().replace(/\s+/g, " "),
    o.priority,
    o.currency.toUpperCase(),
  ]);
}

/** Collapse whitespace and case so one description is one line, not three. */
export function normaliseText(s: string): string {
  return String(s).trim().replace(/\s+/g, " ");
}
