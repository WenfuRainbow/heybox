import * as assert from "node:assert/strict";
import test from "node:test";
import { getReadState, hasNextPage, isUnread } from "../messageState";

test("normalizes all supported read-state fields consistently", () => {
    const cases: Array<[object, "unread" | "read" | "unknown"]> = [
        [{ is_read: 0 }, "unread"], [{ is_read: "1" }, "read"],
        [{ has_read: false }, "unread"], [{ is_unread: true }, "unread"],
        [{ unread: "read" }, "read"], [{ read_status: "unread" }, "unread"],
        [{ is_read: "unexpected" }, "unknown"], [{}, "unknown"],
    ];
    for (const [input, expected] of cases) {
        assert.equal(getReadState(input), expected);
        assert.equal(isUnread(input), expected === "unread");
    }
});

test("does not make an unknown high-priority field override a recognized one", () => {
    assert.equal(getReadState({ is_unread: "maybe", is_read: 0 }), "unread");
    assert.equal(hasNextPage("1"), true);
    assert.equal(hasNextPage(false), false);
    assert.equal(hasNextPage("cursor"), undefined);
});
