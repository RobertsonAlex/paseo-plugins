import assert from "node:assert/strict";
import { test } from "node:test";
import { RESUME_METADATA_KEY, readResumeMarker, reconcileResumeMarker } from "./resume-marker";

const marker = { scheduleId: "s1", at: "2026-11-17T10:00:00.000Z" };

test("readResumeMarker accepts a well-formed value only", () => {
  assert.deepEqual(readResumeMarker({ metadata: { [RESUME_METADATA_KEY]: marker } }), marker);
  assert.equal(readResumeMarker({}), null);
  assert.equal(readResumeMarker({ metadata: { [RESUME_METADATA_KEY]: { scheduleId: 1 } } }), null);
});

test("reconcileResumeMarker clears a stale marker, adds a missing one, leaves a match alone", () => {
  assert.deepEqual(reconcileResumeMarker(marker, undefined), { [RESUME_METADATA_KEY]: null });
  assert.equal(reconcileResumeMarker(null, undefined), null);
  assert.deepEqual(reconcileResumeMarker(null, { id: "s2", nextRunAt: marker.at }), {
    [RESUME_METADATA_KEY]: { scheduleId: "s2", at: marker.at },
  });
  assert.deepEqual(reconcileResumeMarker(marker, { id: "s2", nextRunAt: marker.at }), {
    [RESUME_METADATA_KEY]: { scheduleId: "s2", at: marker.at },
  });
  assert.equal(reconcileResumeMarker(marker, { id: "s1", nextRunAt: marker.at }), null);
});
