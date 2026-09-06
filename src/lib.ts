/**
 * The work order engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). What is re-exported here
 * is the record types, the status machine, the money basis and the store accessors, so a
 * sibling server can read or extend the same `WO-<YYYY>-<NNNN>` series in the same data
 * directory under the same lock without a second copy of the code.
 *
 * The money and VAT arithmetic is NOT re-exported: it lives in
 * `@theluckystrike/mcp-invoice/lib` and this server keeps no copy of it. Import
 * `computeTotals`, `currencyDecimals`, `formatMoney` and `roundHalfUp` from there, the A4
 * renderer `renderDocPdf` from `@theluckystrike/mcp-billing-docs/lib`, and `today` /
 * `isIsoDate` from `@theluckystrike/mcp-quotes/lib`.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-work-order/dist/*.js`
 * deep imports are not.
 */

export type { LabourLine, Line, PartsLine, Party, Priority, Status, StatusEvent, WorkOrder } from "./order.js";
export {
  MAX_HOURS, MAX_LINES, MAX_MARKUP, MAX_MINOR, MAX_QUANTITY, MAX_ROWS, OPEN_STATUSES,
  PRIORITIES, STATUS_ORDER, hoursOf, invoiceItems, isOpen, labourValueMinor, lineCostMinor,
  lineValueMinor, markedUpUnitMinor, netValueMinor, normaliseText, orderKey, partsCostMinor,
  partsValueMinor, payloadTotals, reachedAt, statusIndex, transitionError,
} from "./order.js";

export {
  dataDir, findOrder, getOrders, lockPath, nextId, nextLineId, resolveOrder, setOrders,
} from "./store.js";
