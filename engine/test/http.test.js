import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {validateSpec, runActions} from "../src/index.js";
import {httpResponse, httpRequest} from "../src/tcp.js";

const spec = name => JSON.parse(fs.readFileSync(new URL(`../../validate/tcp/${name}.json`, import.meta.url)));
const acts = name => JSON.parse(fs.readFileSync(new URL(`../../validate/tcp/${name}.actions.json`, import.meta.url)));

test("the HTTP specs pass the spec check; a bad http service is caught", () => {
  for (const n of ["tcp-http", "tcp-http-big"]) { const v = validateSpec(spec(n), acts(n)); assert.ok(v.ok, JSON.stringify(v.errors)); }
  const s = spec("tcp-http"); s.nodes[2].services.http = {"x": "y"}; s.nodes[2].services.tcp["80"] = "gopher";
  const paths = validateSpec(s).errors.map(e => e.path);
  assert.ok(paths.includes("$.nodes[2].services.tcp") && paths.includes("$.nodes[2].services.http"), paths.join());
});

test("a GET gets the page, the server closes first; 404 for an unknown path; refused where nothing listens", () => {
  const r = runActions(spec("tcp-http"), acts("tcp-http")).map(x => x.result ?? x);
  assert.deepEqual(r.slice(0, 3).map(x => [x.ok, x.status, x.bytes]), [[true, 200, 13], [true, 200, 27], [true, 404, 10]]);
  assert.equal(r[3].error, "refused");
  assert.deepEqual(r[0].wire, ["out S", "in SA", "out A", "out PA 34", "in A", "in PA 78", "in FA", "out A", "out FA", "in A"]);
  assert.equal(httpRequest("/", "10.0.0.2").length, 34);
  assert.equal(httpResponse({"/": "hi"}, "/").length, 66);
});

test("a page of several segments arrives complete", () => {
  const [r] = runActions(spec("tcp-http-big"), acts("tcp-http-big")).map(x => x.result ?? x);
  assert.deepEqual([r.ok, r.status, r.bytes], [true, 200, 6400]);
  assert.equal(r.wire.filter(w => /^in .* 1448$/.test(w)).length, 4);
});
