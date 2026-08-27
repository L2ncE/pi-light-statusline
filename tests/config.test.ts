import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LINE1, DEFAULT_LINE2, DEFAULT_RIGHT, normalizeConfig } from "../extensions/config.ts";
import { applyColor, formatTokens, hexToAnsi, rainbow } from "../extensions/ui.ts";
import { parseVibeResponse } from "../extensions/vibes.ts";

test("normalizeConfig defaults when given nothing", () => {
	const config = normalizeConfig(undefined);
	assert.deepEqual(config.line1, DEFAULT_LINE1);
	assert.deepEqual(config.line2, DEFAULT_LINE2);
	assert.deepEqual(config.right, DEFAULT_RIGHT);
	assert.deepEqual(config.colors, {});
	assert.equal(config.vibes.enabled, false);
	assert.equal(config.vibes.fallback, "Working");
	assert.equal(config.vibes.maxLength, 65);
	assert.equal(config.vibes.timeoutMs, 3000);
});

test("normalizeConfig drops unknown segment ids and dedupes", () => {
	const config = normalizeConfig({ line1: ["model", "bogus", "git", "model"], line2: ["tps"], right: [] });
	assert.deepEqual(config.line1, ["model", "git"]);
	assert.deepEqual(config.line2, ["tps"]);
	assert.deepEqual(config.right, []);
});

test("legacy single-line left config splits into the two-line layout", () => {
	const config = normalizeConfig({
		left: ["path", "git", "context", "tps", "cache_rate"],
		right: ["model", "thinking"],
	});
	assert.deepEqual(config.line1, ["path", "git", "context"]);
	assert.deepEqual(config.line2, ["tps", "cache_rate"]);
	assert.deepEqual(config.right, ["model", "thinking"]);
});

test("normalizeConfig keeps only known color/icon keys as trimmed strings", () => {
	const config = normalizeConfig({
		colors: { model: " #0ABAB5 ", nope: "red" },
		icons: { tps: "T" },
	});
	assert.deepEqual(config.colors, { model: "#0ABAB5" });
	assert.deepEqual(config.icons, { tps: "T" });
});

test("normalizeConfig vibes passthrough and clamping", () => {
	const config = normalizeConfig({
		vibes: {
			enabled: true,
			theme: "神龙尊者",
			model: "mccodex/LongCat-Flash-Chat",
			fallback: "龙威震世",
			prompt: "为{theme}生成，任务：{task}",
			maxLength: 18,
			timeoutMs: 2500,
			color: "rainbow",
		},
	});
	assert.equal(config.vibes.enabled, true);
	assert.equal(config.vibes.theme, "神龙尊者");
	assert.equal(config.vibes.model, "mccodex/LongCat-Flash-Chat");
	assert.equal(config.vibes.fallback, "龙威震世");
	assert.equal(config.vibes.maxLength, 18);
	assert.equal(config.vibes.timeoutMs, 2500);
	assert.equal(config.vibes.color, "rainbow");

	const clamped = normalizeConfig({ vibes: { maxLength: 1, timeoutMs: 10, model: "no-slash" } });
	assert.equal(clamped.vibes.maxLength, 65);
	assert.equal(clamped.vibes.timeoutMs, 3000);
	assert.notEqual(clamped.vibes.model, "no-slash");
});

test("formatTokens boundaries", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(9999), "10.0k");
	assert.equal(formatTokens(53000), "53k");
	assert.equal(formatTokens(1_000_000), "1.0M");
	assert.equal(formatTokens(12_000_000), "12M");
});

test("hexToAnsi emits truecolor escape", () => {
	assert.equal(hexToAnsi("#0ABAB5"), "\x1b[38;2;10;186;181m");
});

test("applyColor hex path and semantic fallback path", () => {
	const theme = {
		fg(color: string, text: string): string {
			if (color === "bogus") throw new Error("unknown color");
			return `<${color}>${text}</>`;
		},
	};
	assert.equal(applyColor(theme, "#FF0000", "hi"), "\x1b[38;2;255;0;0mhi\x1b[0m");
	assert.equal(applyColor(theme, "accent", "hi"), "<accent>hi</>");
	assert.equal(applyColor(theme, "bogus", "hi"), "<text>hi</>");
});

test("rainbow colors every non-space char and resets", () => {
	const out = rainbow("ab c");
	assert.ok(out.includes("b \x1b[38;2")); // bare space between colored b and colored c
	assert.equal(out.split("\x1b[38;2").length - 1, 3); // a, b, c each get one color
	assert.ok(out.endsWith("\x1b[0m"));
});

test("parseVibeResponse rules", () => {
	assert.equal(parseVibeResponse("", "fb", 65), "fb...");
	assert.equal(parseVibeResponse("first line\nsecond", "fb", 65), "first line...");
	assert.equal(parseVibeResponse('"quoted"', "fb", 65), "quoted...");
	assert.equal(parseVibeResponse("no ellipsis", "fb", 65), "no ellipsis...");
	assert.equal(parseVibeResponse("trailing dots...", "fb", 65), "trailing dots...");
	assert.equal(parseVibeResponse("这一条消息特别长特别长特别长特别长", "fb", 18).length, 18);
	assert.equal(parseVibeResponse("...", "fb", 65), "fb...");
});
