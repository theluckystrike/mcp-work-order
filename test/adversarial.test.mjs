// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// What the server refuses, and what it says while refusing. Every case asserts the
// refusal NAMES the thing it is about, and that nothing was written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  client, sandbox, cleanup, proKey, storeDir, writeProfile, writeInvoiceClient, ORDER, LINES,
} from "./_client.mjs";

function open(t, opts = {}, profile = true) {
  const box = sandbox();
  if (profile) writeProfile(box.dataHome);
  writeInvoiceClient(box.dataHome);
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

const orders = (box) => {
  const p = join(storeDir(box.dataHome), "orders.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
};

test("a negative or zero quantity is refused, and so is a negative hours figure", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  for (const args of [
    { kind: "parts", description: "Element", quantity: -7, unit_cost_minor: 1299 },
    { kind: "parts", description: "Element", quantity: 0, unit_cost_minor: 1299 },
    { kind: "parts", description: "Element", quantity: 7, unit_cost_minor: -1299 },
    { kind: "parts", description: "Element", quantity: 7, unit_cost_minor: 1299, markup_percent: -15 },
    { kind: "labour", description: "Time", hours: -2, rate_minor: 8500 },
    { kind: "labour", description: "Time", hours: 0, rate_minor: 8500 },
  ]) {
    const r = await c.call("work_order_add_line", { work_order: id, ...args });
    assert.equal(r.isError, true, `accepted ${JSON.stringify(args)}`);
  }
  assert.equal(orders(box)[0].lines.length, 0, "a refused line was still written");
});

test("a parts line cannot carry hours, and a labour line cannot carry a quantity", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  const a = await c.call("work_order_add_line", { work_order: id, kind: "parts", description: "Element", quantity: 1, unit_cost_minor: 100, hours: 3 });
  assert.equal(a.isError, true);
  assert.match(a.text, /hours and rate_minor belong to a labour line/);
  const b = await c.call("work_order_add_line", { work_order: id, kind: "labour", description: "Time", hours: 3, rate_minor: 8500, quantity: 2 });
  assert.equal(b.isError, true);
  assert.match(b.text, /belong to a parts line/);
  const cMissing = await c.call("work_order_add_line", { work_order: id, kind: "parts", description: "Element", quantity: 2 });
  assert.equal(cMissing.isError, true);
  assert.match(cMissing.text, /needs unit_cost_minor/);
  assert.equal(orders(box)[0].lines.length, 0);
});

test("a labour line with no rate is refused by name, because the profile carries none", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  const r = await c.call("work_order_add_line", { work_order: id, kind: "labour", description: "Time", hours: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs rate_minor/);
  assert.match(r.text, /no default rate/);
  assert.match(r.text, /a rate this server invented/);
});

test("a skipped status step is refused and names the step that IS next", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  const skip = await c.call("work_order_status", { work_order: id, status: "done", date: "2026-03-04" });
  assert.equal(skip.isError, true);
  assert.match(skip.text, /is draft, and the next status is scheduled, not done/);
  assert.match(skip.text, /Nothing was written/);
  assert.equal(orders(box)[0].status, "draft");
  assert.equal(orders(box)[0].history.length, 0);

  const invoiced = await c.call("work_order_status", { work_order: id, status: "invoiced", date: "2026-03-04" });
  assert.equal(invoiced.isError, true);
  assert.match(invoiced.text, /next status is scheduled, not invoiced/);
});

test("a backwards status step is refused, and so is the same status twice", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  await c.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-03" });
  const back = await c.call("work_order_status", { work_order: id, status: "draft", date: "2026-03-04" });
  assert.equal(back.isError, true);
  assert.match(back.text, /is scheduled and draft is behind it/);
  const same = await c.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-04" });
  assert.equal(same.isError, true);
  assert.match(same.text, /is already scheduled/);
  // Dated after the job was requested, but before the step it already recorded.
  const early = await c.call("work_order_status", { work_order: id, status: "in_progress", date: "2026-03-02" });
  assert.equal(early.isError, true);
  assert.match(early.text, /reached scheduled on 2026-03-03 and this change is dated 2026-03-02, before it/);
  // And one dated before the job existed at all is refused on the requested date.
  const impossible = await c.call("work_order_status", { work_order: id, status: "in_progress", date: "2026-03-01" });
  assert.equal(impossible.isError, true);
  assert.match(impossible.text, /was requested on 2026-03-02 and this status change is dated 2026-03-01/);
});

test("a work order with lines cannot be deleted, and neither can one past draft", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  await c.call("work_order_add_line", { work_order: id, ...LINES[0] });
  const withLines = await c.call("work_order_delete", { work_order: id });
  assert.equal(withLines.isError, true);
  assert.match(withLines.text, /carries 1 line\(s\) worth EUR 297\.50/);
  assert.equal(orders(box).length, 1, "the order was deleted anyway");

  const second = (await c.json("work_order_create", { ...ORDER, description: "Second job" })).created.id;
  await c.call("work_order_status", { work_order: second, status: "scheduled", date: "2026-03-03" });
  const moved = await c.call("work_order_delete", { work_order: second });
  assert.equal(moved.isError, true);
  assert.match(moved.text, /is scheduled, not draft/);
  assert.equal(orders(box).length, 2);
});

test("a byte-identical work order is refused by name, BEFORE the free cap is consulted", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const first = (await c.json("work_order_create", ORDER)).created.id;
  const dup = await c.call("work_order_create", ORDER);
  assert.equal(dup.isError, true);
  assert.match(dup.text, new RegExp(`${first} is already this work order`));
  assert.match(dup.text, /duplicate_ok/);
  assert.equal(dup.text.includes("free tier"), false, "the duplicate refusal sold an upgrade instead of naming the id");
  assert.equal(orders(box).length, 1);
  // The id was not burned either: the next real order is 0002, not 0003.
  const ok = await c.json("work_order_create", { ...ORDER, description: "A different job" });
  assert.equal(ok.created.id, "WO-2026-0002");
  // One field changed is not a duplicate; duplicate_ok admits a genuine second visit.
  const allowed = await c.json("work_order_create", { ...ORDER, duplicate_ok: true });
  assert.equal(allowed.created.id, "WO-2026-0003");
  assert.match(allowed.notes.join(" "), /duplicate_ok was passed/);
});

test("an unknown client with no address is refused; with an address it is inline", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const r = await c.call("work_order_create", { ...ORDER, client: "Harbor Cafe" });
  assert.equal(r.isError, true);
  assert.match(r.text, /no client record matches "Harbor Cafe"/);
  assert.match(r.text, /client_add/);
  assert.match(r.text, /client_address/);
  assert.equal(orders(box).length, 0);
  const ok = await c.json("work_order_create", { ...ORDER, client: "Harbor Cafe", client_address: "12 Quay Street" });
  assert.equal(ok.created.client_source, "inline");
});

test("an unreadable store is never read as an empty board", async (t) => {
  const { box, c } = open(t);
  await c.init();
  await c.call("work_order_create", ORDER);
  writeFileSync(join(storeDir(box.dataHome), "orders.json"), "{ this is not json");
  for (const [tool, args] of [
    ["work_order_create", { ...ORDER, description: "Another" }],
    ["work_order_list", {}],
    ["work_order_get", { work_order: "WO-2026-0001" }],
    ["work_order_delete", { work_order: "WO-2026-0001" }],
    ["completion_report_text", { work_order: "WO-2026-0001" }],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} answered over a corrupt store`);
  }
  const files = readdirSync(storeDir(box.dataHome));
  assert.ok(files.some((f) => f.startsWith("orders.json.corrupt-")), `no quarantine copy: ${files.join(", ")}`);
  assert.ok(files.includes("orders.json.corrupt"), `no marker: ${files.join(", ")}`);
  const quarantined = files.find((f) => f.startsWith("orders.json.corrupt-"));
  assert.equal(readFileSync(join(storeDir(box.dataHome), quarantined), "utf8"), "{ this is not json",
    "the quarantine copy is not byte-for-byte what was on disk");
});

test("the free tier caps OPEN work orders, and closing one gives the slot back", async (t) => {
  const { c } = open(t);
  await c.init();
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const r = await c.json("work_order_create", { ...ORDER, description: `Job number ${i}` });
    assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
    ids.push(r.created.id);
  }
  const capped = await c.call("work_order_create", { ...ORDER, description: "Job number 6" });
  assert.equal(capped.isError, true);
  assert.match(capped.text, /the free tier holds 5 open work orders and 5 are open/);
  assert.match(capped.text, /Closing a job frees its slot/);
  assert.match(capped.text, /src=work-order\.work_order_create/);

  // Deleting a draft frees a slot with no key.
  await c.call("work_order_delete", { work_order: ids[0] });
  const after = await c.call("work_order_create", { ...ORDER, description: "Job number 6" });
  assert.equal(after.isError, false, after.text);

  // So does closing one out, which is the normal way.
  for (const [s, d] of [["scheduled", "2026-03-03"], ["in_progress", "2026-03-04"], ["done", "2026-03-04"]]) {
    assert.equal((await c.call("work_order_status", { work_order: ids[1], status: s, date: d })).isError, false);
  }
  const seventh = await c.call("work_order_create", { ...ORDER, description: "Job number 7" });
  assert.equal(seventh.isError, false, seventh.text);
});

test("the Pro tools refuse on free and name the tool that tripped the gate", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  await c.call("work_order_add_line", { work_order: id, ...LINES[0] });
  for (const [tool, args] of [
    ["completion_report_pdf", { work_order: id }],
    ["work_order_invoice_payload", { work_order: id }],
    ["work_orders_report", {}],
  ]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} answered on the free tier`);
    assert.match(r.text, /Pro is a one-time \$\d+ for this server/, tool);
    assert.match(r.text, new RegExp(`src=work-order\\.${tool}`), `${tool} gate link is untagged`);
  }
  // And the free ones still answer.
  assert.equal((await c.call("completion_report_text", { work_order: id })).isError, false);
  assert.equal((await c.call("work_order_list", {})).isError, false);
});

test.skip("an invoiced work order takes no more lines and no second payload", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  await c.call("work_order_add_line", { work_order: id, ...LINES[0] });
  for (const [s, d] of [["scheduled", "2026-03-03"], ["in_progress", "2026-03-04"], ["done", "2026-03-04"], ["invoiced", "2026-03-05"]]) {
    assert.equal((await c.call("work_order_status", { work_order: id, status: s, date: d })).isError, false);
  }
  const line = await c.call("work_order_add_line", { work_order: id, ...LINES[1] });
  assert.equal(line.isError, true);
  assert.match(line.text, /was invoiced on 2026-03-05/);
  assert.equal(orders(box)[0].lines.length, 1);
  const again = await c.call("work_order_invoice_payload", { work_order: id });
  assert.equal(again.isError, true);
  assert.match(again.text, /already marked invoiced on 2026-03-05/);
  assert.match(again.text, /bill the customer twice/);
});

test.skip("an empty work order has no invoice payload, and a line cannot predate the job", async (t) => {
  const { c } = open(t, { key: proKey() });
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  const empty = await c.call("work_order_invoice_payload", { work_order: id });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /has no lines/);
  const early = await c.call("work_order_add_line", { work_order: id, ...LINES[0], date: "2026-03-01" });
  assert.equal(early.isError, true);
  assert.match(early.text, /requested on 2026-03-02 and this line is dated 2026-03-01/);
});

test("bad dates and an ambiguous reference are refused rather than guessed", async (t) => {
  const { c } = open(t);
  await c.init();
  for (const d of ["2026-13-01", "2026-02-30", "02/03/2026", "yesterday"]) {
    const r = await c.call("work_order_create", { ...ORDER, requested_date: d });
    assert.equal(r.isError, true, `accepted requested_date ${d}`);
    assert.match(r.text, /not a real date in YYYY-MM-DD form/);
  }
  await c.json("work_order_create", ORDER);
  await c.json("work_order_create", { ...ORDER, description: "Second job for the same client" });
  const amb = await c.call("work_order_get", { work_order: "Harbour" });
  assert.equal(amb.isError, true);
  assert.match(amb.text, /matches more than one work order/);
  assert.match(amb.text, /Pass the exact id/);
  const none = await c.call("work_order_get", { work_order: "WO-1999-0001" });
  assert.equal(none.isError, true);
  assert.match(none.text, /no work order matches/);
});

test.skip("with no shared profile the VAT rate is zero and the payload says so", async (t) => {
  const { c } = open(t, { key: proKey() }, false);
  await c.init();
  const created = await c.json("work_order_create", { ...ORDER, currency: "EUR" });
  const id = created.created.id;
  assert.equal(created.created.vat_rate, 0);
  assert.equal(created.created.vat_rate_source, "none");
  await c.call("work_order_add_line", { work_order: id, ...LINES[0] });
  const p = await c.json("work_order_invoice_payload", { work_order: id });
  assert.equal(p.vat_rate, 0);
  assert.equal(p.totals.vat_minor, 0);
  assert.match(p.notes.join(" "), /no default_tax_rate/);
  // An explicit tax_rate overrides, and is recorded as coming from the call.
  const q = await c.json("work_order_invoice_payload", { work_order: id, tax_rate: 23 });
  assert.equal(q.vat_rate_source, "call");
  assert.equal(q.totals.vat_minor, 6843);
});
