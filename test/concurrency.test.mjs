// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Two processes sharing one data directory. The check and the write have to be one
// critical section or the free cap is decorative and lines go missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, sandbox, cleanup, proKey, storeDir, writeProfile, writeInvoiceClient, ORDER } from "./_client.mjs";

function pair(t, opts = {}) {
  const box = sandbox();
  writeProfile(box.dataHome);
  writeInvoiceClient(box.dataHome);
  const a = client({ dataHome: box.dataHome, ...opts });
  const b = client({ dataHome: box.dataHome, ...opts });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  return { box, a, b };
}

const stored = (box) => JSON.parse(readFileSync(join(storeDir(box.dataHome), "orders.json"), "utf8"));

test.skip("forty work orders raised from two processes are all stored, with forty distinct ids", async (t) => {
  const { box, a, b } = pair(t, { key: proKey() });
  await Promise.all([a.init(), b.init()]);
  const calls = [];
  for (let i = 0; i < 20; i++) {
    calls.push(a.call("work_order_create", { ...ORDER, description: `Job A${i}` }));
    calls.push(b.call("work_order_create", { ...ORDER, description: `Job B${i}` }));
  }
  const results = await Promise.all(calls);
  const failed = results.filter((r) => r.isError);
  assert.deepEqual(failed.map((r) => r.text), [], "a write was refused under contention");
  const list = stored(box);
  assert.equal(list.length, 40);
  assert.equal(new Set(list.map((o) => o.id)).size, 40, "two work orders got the same number");
});

test("the race on the sixth free open work order: exactly five are stored", async (t) => {
  const { box, a, b } = pair(t);
  await Promise.all([a.init(), b.init()]);
  const calls = [];
  for (let i = 0; i < 6; i++) {
    calls.push(a.call("work_order_create", { ...ORDER, description: `Job A${i}` }));
    calls.push(b.call("work_order_create", { ...ORDER, description: `Job B${i}` }));
  }
  const results = await Promise.all(calls);
  const accepted = results.filter((r) => !r.isError).length;
  const refused = results.filter((r) => r.isError);
  assert.equal(accepted, 5, `${accepted} work orders were accepted against a free cap of 5`);
  assert.equal(refused.length, 7);
  for (const r of refused) assert.match(r.text, /the free tier holds 5 open work orders/);
  assert.equal(stored(box).length, 5);
});

test.skip("lines added to one order from two processes are all kept", async (t) => {
  const { box, a, b } = pair(t, { key: proKey() });
  await Promise.all([a.init(), b.init()]);
  const id = (await a.json("work_order_create", ORDER)).created.id;
  const calls = [];
  for (let i = 0; i < 15; i++) {
    calls.push(a.call("work_order_add_line", { work_order: id, kind: "labour", description: `A${i}`, hours: 1, rate_minor: 8500 }));
    calls.push(b.call("work_order_add_line", { work_order: id, kind: "parts", description: `B${i}`, quantity: 1, unit_cost_minor: 100 }));
  }
  const results = await Promise.all(calls);
  assert.deepEqual(results.filter((r) => r.isError).map((r) => r.text), []);
  const o = stored(box)[0];
  assert.equal(o.lines.length, 30, "a line was lost to a lost update");
  assert.equal(new Set(o.lines.map((l) => l.id)).size, 30, "two lines got the same id");
});

test.skip("a status change racing a line does not lose either", async (t) => {
  const { box, a, b } = pair(t, { key: proKey() });
  await Promise.all([a.init(), b.init()]);
  const id = (await a.json("work_order_create", ORDER)).created.id;
  const [line, moved] = await Promise.all([
    a.call("work_order_add_line", { work_order: id, kind: "labour", description: "Time", hours: 2, rate_minor: 8500, date: "2026-03-04" }),
    b.call("work_order_status", { work_order: id, status: "scheduled", date: "2026-03-03" }),
  ]);
  assert.equal(line.isError, false, line.text);
  assert.equal(moved.isError, false, moved.text);
  const o = stored(box)[0];
  assert.equal(o.lines.length, 1);
  assert.equal(o.status, "scheduled");
  assert.equal(o.history.length, 1);
});
