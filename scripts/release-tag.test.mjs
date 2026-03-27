import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseTag } from "./release-tag.mjs";

test("parseReleaseTag returns latest for stable tags", () => {
  assert.deepEqual(parseReleaseTag("v0.7.0"), {
    tagName: "v0.7.0",
    version: "0.7.0",
    prerelease: null,
    isPrerelease: false,
    channel: null,
    npmDistTag: "latest",
  });
});

test("parseReleaseTag returns prerelease metadata for beta tags", () => {
  assert.deepEqual(parseReleaseTag("v0.7.0-beta.2"), {
    tagName: "v0.7.0-beta.2",
    version: "0.7.0-beta.2",
    prerelease: "beta.2",
    isPrerelease: true,
    channel: "beta",
    npmDistTag: "beta",
  });
});

test("parseReleaseTag rejects channels that do not start with a letter", () => {
  assert.throws(
    () => parseReleaseTag("v0.7.0-1beta.2"),
    /Expected a leading alphabetic identifier like beta or rc/,
  );
});
