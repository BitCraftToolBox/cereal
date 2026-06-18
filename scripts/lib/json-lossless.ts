/**
 * json-lossless.ts
 *
 * `JSON.parse` parses every number as an IEEE-754 double, so any integer outside the
 * safe range (|n| > 2^53 − 1) is silently rounded. State dumps are BSATN-serialized by
 * the C# SDK, which writes U64 ids as bare JSON number literals — those routinely
 * exceed 2^53 and would lose their low-order digits, breaking value-based matching
 * (two distinct ids can collapse to the same rounded double).
 *
 * `parseJsonLossless` preserves such integers by emitting them as **strings** (full
 * precision, trivially comparable and JSON-serializable). Safe-range integers and all
 * other values are returned unchanged, so small desc PKs stay numbers and matching is
 * consistent across files (an id is large — and therefore a string — everywhere or
 * nowhere).
 *
 * Relies on the JSON.parse reviver "source text access" (`context.source`), available in
 * V8 / Node ≥ 21. We throw if it is unavailable rather than silently corrupting ids.
 */

type ReviverContext = { source?: string };

let sourceAccessChecked = false;
let sourceAccessAvailable = false;

function ensureSourceAccess(): void {
    if (sourceAccessChecked) {
        if (!sourceAccessAvailable) {
            throw new Error(
                "parseJsonLossless requires JSON.parse source-text access (Node ≥ 21); " +
                "large U64 ids would lose precision otherwise.",
            );
        }
        return;
    }
    sourceAccessChecked = true;
    JSON.parse("1", (_k, _v, ctx?: ReviverContext) => {
        if (ctx && typeof ctx.source === "string") sourceAccessAvailable = true;
        return _v;
    });
    if (!sourceAccessAvailable) {
        throw new Error(
            "parseJsonLossless requires JSON.parse source-text access (Node ≥ 21); " +
            "large U64 ids would lose precision otherwise.",
        );
    }
}

/**
 * Parse JSON, preserving integers outside the IEEE-754 safe range as decimal strings.
 * Floats and safe-range integers are returned as `number`; everything else is unchanged.
 */
export function parseJsonLossless<T = unknown>(text: string): T {
    ensureSourceAccess();
    return JSON.parse(text, (_key, value, context?: ReviverContext) => {
        if (
            typeof value === "number" &&
            context &&
            typeof context.source === "string" &&
            !Number.isSafeInteger(value) &&
            // Only rescue integer literals (no '.', 'e', 'E') that lost precision.
            /^-?\d+$/.test(context.source)
        ) {
            return context.source;
        }
        return value;
    }) as T;
}
