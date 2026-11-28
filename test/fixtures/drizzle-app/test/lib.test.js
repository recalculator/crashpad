import assert from "node:assert/strict";
import { test } from "node:test";
import { slug } from "../lib.js";

test("slug", () => {
  assert.equal(slug("Hello, World"), "hello-world");
});
