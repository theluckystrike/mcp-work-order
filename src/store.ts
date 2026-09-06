import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-timezone/lib";
import type { WorkOrder } from "./order.js";

/**
 * Work orders live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/work-order/`, in `orders.json` and
 * `counter.json`. Nothing else is written anywhere.
 *
 * ONE sibling store is READ and never written: `servers/invoice`'s `clients.json`, through
 * `findClient` from `@theluckystrike/mcp-invoice/lib`, so a job carries the same client
 * record the invoice will be raised against rather than a second spelling of the name.
 * `work_order_invoice_payload` returns `invoice_create` arguments; it does not create the
 * invoice, and this server never writes into the invoice data directory.
 *
 * NO TOTAL IS STORED. An order record holds its lines and its status history; the value,
 * the hours, the materials and the VAT are derived on every call. A stored total is a
 * second copy of what the lines already decide, and the copy is the one that gets believed
 * after somebody edits a line.
 *
 * Reads go through the timezone engine's `readJsonFile`, so a store that is not JSON is
 * quarantined byte-for-byte as `<file>.corrupt-<timestamp>` with a `.corrupt` marker beside
 * it, and every later call fails loudly instead of reading a file that is still on disk as
 * "no work orders" and reporting a clean board.
 */

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dir = join(base, "mcp-servers", "work-order");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function lockPath(): string { return join(dataDir(), ".lock"); }

function read<T>(file: string, empty: T): T {
  return readJsonFile<T>(join(dataDir(), file), empty);
}

/** Atomic: per-process temp name, then rename over the target. */
function write(file: string, value: unknown): void {
  const p = join(dataDir(), file);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, p);
}

export function getOrders(): WorkOrder[] { return read<WorkOrder[]>("orders.json", []); }
export function setOrders(v: WorkOrder[]): void { write("orders.json", v); }

/**
 * Allocate the next id in the `WO-<YYYY>-<NNNN>` series.
 *
 * The counter is per year and is written BEFORE the record is stored, so a crash burns a
 * number rather than reusing one. Ids already in the store are also scanned, so a restored
 * or hand-edited store cannot reissue a number that is already written on a paper job card.
 */
export function nextId(year: string, existing: string[]): string {
  const counters = read<Record<string, number>>("counter.json", {});
  const key = `WO-${year}`;
  let n = counters[key] ?? 0;
  const used = new Set(existing);
  do { n += 1; } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
  counters[key] = n;
  write("counter.json", counters);
  return `${key}-${String(n).padStart(4, "0")}`;
}

/** Allocate the next line id within one order. Line ids never repeat inside an order. */
export function nextLineId(o: WorkOrder): string {
  let n = o.lines.length;
  const used = new Set(o.lines.map((l) => l.id));
  let id: string;
  do { n += 1; id = `L${String(n).padStart(2, "0")}`; } while (used.has(id));
  return id;
}

/**
 * Resolve a work order by exact id (case-insensitive), then by exact client name, then --
 * only if nothing exact matched -- by partial client name. More than one partial candidate
 * is refused with the list rather than silently picking the first, so a part cannot be
 * booked to the wrong job.
 */
export function findOrder(list: WorkOrder[], ref: string): WorkOrder | undefined {
  const needle = String(ref).trim().toLowerCase();
  const byId = list.find((o) => o.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = list.filter((o) => o.client.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const pool = exact.length ? exact : list.filter((o) => o.client.name.toLowerCase().includes(needle));
  if (pool.length > 1) {
    throw new Error(`"${ref}" matches more than one work order: ${pool.map((o) => `${o.id} (${o.client.name}, ${o.status})`).join(", ")}. Pass the exact id.`);
  }
  return pool[0];
}

export function resolveOrder(list: WorkOrder[], ref: string): WorkOrder {
  if (!list.length) throw new Error("there is no work order yet. Run work_order_create with a client, a site address, a requested date and what the job is.");
  const o = findOrder(list, ref);
  if (!o) throw new Error(`no work order matches "${ref}". Ids look like WO-2026-0001. Run work_order_list to see them.`);
  return o;
}
