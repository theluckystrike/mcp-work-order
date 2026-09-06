// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// The worked job, recomputed by hand and asserted to the minor unit.
//
// The single load-bearing assertion is the last one: the invoice payload's totals are
// recomputed from the payload's OWN items with servers/invoice's computeTotals, so the
// figures this server reports are the figures invoice_create will produce, not a second
// implementation that happens to agree today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeTotals } from "@theluckystrike/mcp-invoice/lib";
import {
  client, sandbox, cleanup, proKey, storeDir, writeProfile, writeInvoiceClient,
  ORDER, LINES, HOURS, LABOUR_MINOR, MATERIALS_MINOR, PARTS_COST_MINOR, NET_MINOR, VAT_MINOR, GROSS_MINOR,
} from "./_client.mjs";

function open(t, opts = {}) {
  const box = sandbox();
  writeProfile(box.dataHome);
  writeInvoiceClient(box.dataHome);
  const c = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

async function workedOrder(c) {
  const created = await c.json("work_order_create", ORDER);
  assert.equal(created.isError, undefined, JSON.stringify(created).slice(0, 400));
  for (const l of LINES) {
    const r = await c.call("work_order_add_line", { work_order: created.created.id, ...l });
    assert.equal(r.isError, false, r.text);
  }
  return created.created.id;
}

test("the client comes from the invoice client records, with its address and VAT id", async (t) => {
  const { c } = open(t);
  await c.init();
  const r = await c.json("work_order_create", ORDER);
  assert.equal(r.created.id, "WO-2026-0001");
  assert.equal(r.created.client_source, "invoice client record");
  assert.equal(r.created.client_id, "a1b2c3d4");
  assert.equal(r.created.client_record.vat_id, "PL1234567890");
  assert.equal(r.created.currency, "EUR", "the currency falls through to the shared profile");
  assert.equal(r.created.status, "draft");
  assert.equal(r.created.priority, "high");
  assert.equal(r.created.vat_rate, 23);
  assert.equal(r.created.vat_rate_source, "shared profile");
});

test("an inline client is recorded as inline and says the invoice server has no record of it", async (t) => {
  const { c } = open(t);
  await c.init();
  const r = await c.json("work_order_create", {
    ...ORDER, client: "Baltic Bakery", client_address: "9 Mill Lane, Sopot",
  });
  assert.equal(r.created.client_source, "inline");
  assert.equal(r.created.client_id, null);
  assert.match(r.notes.join(" "), /not in the invoice client records/);
});

test("the worked job totals to the minor unit: hours, labour, materials, net, VAT and gross", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await workedOrder(c);
  const got = (await c.json("work_order_get", { work_order: id })).work_order;

  assert.equal(got.hours, HOURS);
  assert.equal(got.labour_minor, LABOUR_MINOR);
  assert.equal(got.materials_minor, MATERIALS_MINOR);
  assert.equal(got.parts_cost_minor, PARTS_COST_MINOR);
  assert.equal(got.markup_earned_minor, MATERIALS_MINOR - PARTS_COST_MINOR);
  assert.equal(got.net_minor, NET_MINOR);
  assert.equal(got.vat_minor, VAT_MINOR);
  assert.equal(got.gross_minor, GROSS_MINOR);
  assert.equal(got.net, "EUR 598.33");
  assert.equal(got.gross, "EUR 735.95");
});

test("the markup goes on the unit, and the line total basis is one minor unit away", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await workedOrder(c);
  const got = (await c.json("work_order_get", { work_order: id })).work_order;
  const marked = got.lines_detail.find((l) => l.markup_percent === 15);

  // 1299 * 1.15 = 1493.85 -> 1494 a unit; 1494 * 7 = 10,458.
  assert.equal(marked.billed_unit_minor, 1494);
  assert.equal(marked.value_minor, 10458);
  // Marking up the LINE TOTAL instead: round(1299 * 7 * 1.15) = round(10456.95) = 10,457.
  const lineTotalBasis = Math.round(1299 * 7 * 1.15);
  assert.equal(lineTotalBasis, 10457);
  assert.equal(marked.value_minor - lineTotalBasis, 1,
    "the two bases must differ here, or this test is not measuring anything");
});

test.skip("the invoice payload's totals equal computeTotals over the payload's own items", async (t) => {
  const { c } = open(t, { key: proKey() });
  await c.init();
  const id = await workedOrder(c);
  await c.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-03" });
  await c.call("work_order_status", { work_order: id, status: "in_progress", date: "2026-03-04" });
  await c.call("work_order_status", { work_order: id, status: "done", date: "2026-03-04" });

  const p = await c.json("work_order_invoice_payload", { work_order: id, issue_date: "2026-03-05" });
  assert.equal(p.isError, undefined, JSON.stringify(p).slice(0, 400));
  assert.equal(p.invoice_create.tool, "invoice_create");
  assert.equal(p.invoice_create.server, "invoice");
  assert.equal(p.invoice_create.arguments.client, "a1b2c3d4");
  assert.equal(p.invoice_create.arguments.currency, "EUR");
  assert.equal(p.invoice_create.arguments.issue_date, "2026-03-05");
  assert.equal(p.invoice_create.arguments.items.length, 4);
  assert.equal(p.posted, false);
  assert.equal(p.marked_invoiced, false);

  // THE assertion: run the payload through the invoice server's own engine.
  const recomputed = computeTotals(p.invoice_create.arguments.items, "EUR", 0, 23);
  assert.equal(recomputed.net_minor, NET_MINOR);
  assert.equal(recomputed.tax_minor, VAT_MINOR);
  assert.equal(recomputed.total_minor, GROSS_MINOR);
  assert.equal(p.totals.net_minor, recomputed.net_minor);
  assert.equal(p.totals.vat_minor, recomputed.tax_minor);
  assert.equal(p.totals.total_minor, recomputed.total_minor);
  assert.equal(p.totals.subtotal_minor, recomputed.subtotal_minor);
  // And line by line, so a total that happens to agree by cancellation cannot pass.
  const mine = p.invoice_create.arguments.items.map((_, i) => recomputed.lines[i].gross_minor);
  assert.deepEqual(mine, [29750, 10625, 10458, 9000]);
  assert.equal(recomputed.rounding_drift_minor, 0,
    "a payload that drifts under the other rounding basis would bill a figure the work order never showed");
});

test("the status machine records every step with its own date and note", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await workedOrder(c);
  for (const [status, date, note] of [
    ["scheduled", "2026-03-03", "Booked for Wednesday morning"],
    ["in_progress", "2026-03-04", "On site 08:10"],
    ["done", "2026-03-04", "Signed off by the manager"],
    ["invoiced", "2026-03-05", "INV-2026-0007"],
  ]) {
    const r = await c.json("work_order_status", { work_order: id, status, date, note });
    assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
    assert.equal(r.work_order.status, status);
    assert.equal(r.moved.date, date);
    assert.equal(r.moved.note, note);
  }
  const got = (await c.json("work_order_get", { work_order: id })).work_order;
  assert.deepEqual(got.history.map((h) => [h.from, h.to]), [
    ["draft", "scheduled"], ["scheduled", "in_progress"], ["in_progress", "done"], ["done", "invoiced"],
  ]);
  assert.equal(got.open, false);
});

test("the completion report carries the hours, the materials, the totals and a sign-off block", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await workedOrder(c);
  await c.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-03" });
  await c.call("work_order_status", { work_order: id, status: "in_progress", date: "2026-03-04" });
  await c.call("work_order_status", { work_order: id, status: "done", date: "2026-03-04" });

  const r = await c.call("completion_report_text", { work_order: id });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^COMPLETION REPORT\nWO-2026-0001/);
  assert.match(r.text, /Nova Trades/);
  assert.match(r.text, /Client        Harbour Cafe/);
  assert.match(r.text, /Site          12 Quay Street, Gdansk/);
  assert.match(r.text, /Completed     2026-03-04/);
  assert.match(r.text, /Hours 4\.75, labour EUR 403\.75/);
  assert.match(r.text, /Materials EUR 194\.58/);
  assert.match(r.text, /Net    EUR 598\.33/);
  assert.match(r.text, /VAT 23% on EUR 598\.33  EUR 137\.62/);
  assert.match(r.text, /Total  EUR 735\.95/);
  assert.match(r.text, /Received and accepted by/);
  // 7 x the BILLED unit, not the cost.
  assert.match(r.text, /3kW immersion element  7 x EUR 14\.94  EUR 104\.58/);
});

test.skip("the PDF is written and names the work order", async (t) => {
  const { box, c } = open(t, { key: proKey() });
  await c.init();
  const id = await workedOrder(c);
  const r = await c.json("completion_report_pdf", { work_order: id });
  assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
  assert.equal(r.path, join(storeDir(box.dataHome), "pdf", "WO-2026-0001.pdf"));
  assert.equal(r.total_minor, GROSS_MINOR);
  const bytes = readFileSync(r.path);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.ok(bytes.length > 1000, `the PDF is only ${bytes.length} bytes`);
});

test.skip("the board report counts statuses, this month's hours and the unbilled value", async (t) => {
  const { c } = open(t, { key: proKey() });
  await c.init();
  const id = await workedOrder(c);
  await c.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-03" });
  const second = (await c.json("work_order_create", {
    ...ORDER, requested_date: "2026-03-06", description: "Annual boiler service",
  })).created.id;
  await c.call("work_order_add_line", { work_order: second, kind: "labour", description: "Service", hours: 1, rate_minor: 8500, date: "2026-04-02" });

  const rep = await c.json("work_orders_report", { month: "2026-03" });
  assert.equal(rep.work_orders, 2);
  assert.equal(rep.open, 2);
  assert.deepEqual(rep.by_status.filter((s) => s.count).map((s) => [s.status, s.count]), [["draft", 1], ["scheduled", 1]]);
  // The April labour line does NOT count in March, although its order was requested in March.
  assert.equal(rep.hours_this_month, HOURS);
  assert.deepEqual(rep.hours_this_month_by_order, [{ id, hours: HOURS }]);
  const eur = rep.unbilled_by_currency.find((x) => x.currency === "EUR");
  assert.equal(eur.work_orders, 2);
  assert.equal(eur.unbilled_minor, NET_MINOR + 8500);
  assert.equal(rep.oldest_open[0].id, id);

  const april = await c.json("work_orders_report", { month: "2026-04" });
  assert.equal(april.hours_this_month, 1);
});

test("a draft with no lines is deleted free and gives its open slot back", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = (await c.json("work_order_create", ORDER)).created.id;
  const r = await c.json("work_order_delete", { work_order: id });
  assert.equal(r.deleted.id, id);
  assert.equal(r.open_work_orders, 0);
  assert.equal(r.free_tier_open_limit, 5);
  assert.match(r.note, /not reissued/);
  // The number is not reissued: the next order is 0002, so the gap records the deletion.
  const next = await c.json("work_order_create", { ...ORDER, description: "A different job" });
  assert.equal(next.created.id, "WO-2026-0002");
});

test("work_order_list filters by status, client and requested-date range", async (t) => {
  const { c } = open(t);
  await c.init();
  const a = (await c.json("work_order_create", ORDER)).created.id;
  await c.json("work_order_create", { ...ORDER, requested_date: "2026-05-11", description: "Leak on the mains", client: "Baltic Bakery", client_address: "9 Mill Lane, Sopot" });
  await c.call("work_order_status", { work_order: a, status: "scheduled", date: "2026-03-03" });

  assert.equal((await c.json("work_order_list", {})).count, 2);
  assert.equal((await c.json("work_order_list", { status: "open" })).count, 2);
  assert.equal((await c.json("work_order_list", { status: "scheduled" })).count, 1);
  assert.equal((await c.json("work_order_list", { client: "harbour" })).count, 1);
  assert.equal((await c.json("work_order_list", { from: "2026-04-01" })).count, 1);
  assert.equal((await c.json("work_order_list", { to: "2026-03-31" })).count, 1);
  const list = await c.json("work_order_list", { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(list.work_orders.map((o) => o.requested_date), ["2026-05-11", "2026-03-02"]);
  assert.equal(list.totals[0].currency, "EUR");
});
