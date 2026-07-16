import {versionTagInRange} from "../lib/fk-detector";

function testRange(e: boolean, v: string, min?: string, max?: string) {
    if (e !== versionTagInRange(v, min, max)) {
        console.log(`FAILED: v=${v} min=${min} max=${max}, expected: ${e}`);
    }
}
testRange(true, "2026-07-09", "2026-07-09");
testRange(true, "2026-07-09", undefined, "2026-07-10");
testRange(true, "2026-07-09", "2026-07-09", "2026-07-10");

testRange(true, "2026-07-09-1", "2026-07-09");
testRange(true, "2026-07-09-1", "2026-07-09-1");
testRange(true, "2026-07-09-2", "2026-07-09-1");
testRange(true, "2026-07-09", undefined, "2026-07-09-1");
testRange(true, "2026-07-09-1", undefined, "2026-07-09-2");
testRange(true, "2026-07-09-1", undefined, "2026-07-10");

testRange(false, "2026-07-09", "2026-07-10");
testRange(false, "2026-07-09", undefined, "2026-07-09");
testRange(false, "2026-07-09", undefined, "2026-07-08");

testRange(false, "2026-07-09-1", "2026-07-09-2");
testRange(false, "2026-07-09-1", "2026-07-10");
testRange(false, "2026-07-09-1", undefined, "2026-07-09-1");
testRange(false, "2026-07-09-2", undefined, "2026-07-09-1");
testRange(false, "2026-07-09-1", undefined, "2026-07-09");
testRange(false, "2026-07-09-1", undefined, "2026-07-08");

console.log("Done")