/**
 * Unit tests for readonly resolution logic (mirrors packages/webapp logic).
 * Run: node --test tests/*.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function resolveReadonlyMode(dataMode, env = {}) {
  const flag = (name) => {
    const v = (env[name] || "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  };
  const rawRo = (env.A2AX_READONLY || "").trim().toLowerCase();
  const forceWrite =
    rawRo === "0" || rawRo === "false" || rawRo === "no" || rawRo === "off";
  const authority = flag("A2AX_AUTHORITY");

  if (forceWrite) {
    return { readonly: false, reason: "A2AX_READONLY=0" };
  }
  if (flag("A2AX_READONLY")) {
    return { readonly: true, reason: "A2AX_READONLY" };
  }
  if (authority) {
    return { readonly: false, reason: "A2AX_AUTHORITY" };
  }
  if (dataMode === "live") {
    return { readonly: true, reason: "auto:live-data-without-A2AX_AUTHORITY" };
  }
  return { readonly: false, reason: "default-empty-or-demo" };
}

describe("resolveReadonlyMode", () => {
  it("defaults live data to readonly without authority", () => {
    const r = resolveReadonlyMode("live", {});
    assert.equal(r.readonly, true);
    assert.match(r.reason, /auto:live/);
  });

  it("A2AX_AUTHORITY enables write on live", () => {
    const r = resolveReadonlyMode("live", { A2AX_AUTHORITY: "1" });
    assert.equal(r.readonly, false);
  });

  it("explicit A2AX_READONLY=1 stays readonly", () => {
    const r = resolveReadonlyMode("live", { A2AX_READONLY: "1", A2AX_AUTHORITY: "1" });
    // explicit READONLY takes precedence over AUTHORITY in our resolve order...
    // Actually in resolveReadonlyMode AUTHORITY is checked after READONLY flag.
    // flag READONLY first after forceWrite.
    assert.equal(r.readonly, true);
  });

  it("A2AX_READONLY=0 forces write", () => {
    const r = resolveReadonlyMode("live", { A2AX_READONLY: "0" });
    assert.equal(r.readonly, false);
  });

  it("empty/demo is writable by default", () => {
    const r = resolveReadonlyMode("empty_or_demo", {});
    assert.equal(r.readonly, false);
  });
});
