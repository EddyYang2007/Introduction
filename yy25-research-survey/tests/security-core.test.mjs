import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanText, isLoopbackIp, originIsAllowed, parseCookies, randomToken,
  safeEqualText, sha256, securityHeaders,
} from "../src/security.mjs";

test("security helpers strip control characters and distinguish tokens", () => {
  assert.equal(cleanText("line\u0000break", 40), "line break");
  assert.equal(isLoopbackIp("127.0.0.1"), true);
  assert.equal(isLoopbackIp("8.8.8.8"), false);
  assert.equal(originIsAllowed({ headers: { origin: "https://example.test" } }, "https://example.test"), true);
  assert.equal(originIsAllowed({ headers: { origin: "https://attacker.test" } }, "https://example.test"), false);
  const token = randomToken(32);
  assert.ok(token.length >= 32);
  assert.equal(safeEqualText(token, token), true);
  assert.equal(safeEqualText(token, "different"), false);
  assert.equal(sha256(token).length, 64);
});

test("cookie parsing and security headers preserve privacy defaults", () => {
  assert.deepEqual(parseCookies("a=1; b=two"), { a: "1", b: "two" });
  const headers = securityHeaders({ secure: true, hsts: true });
  assert.match(headers["Cache-Control"], /no-store/);
  assert.match(headers["X-Robots-Tag"], /noindex/);
  assert.ok(headers["Strict-Transport-Security"]);
});


