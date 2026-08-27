// pi-light-statusline: a lightweight replacement for pi's built-in footer.
//
// Official-style layout (left stats, right-aligned model + thinking level,
// extension statuses on their own line below), with colors, icons, live tok/s
// and cache-hit rate. Optional AI-generated working vibes.
//
// Segment ids and all options are configured via the "lightStatusline" block
// in ~/.pi/agent/settings.json; see config.ts for the schema.

import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, loadConfig, type SegmentId } from "./config.ts";
import { initVibes, onVibeAgentEnd, onVibeAgentStart, onVibeBeforeAgentStart } from "./vibes.ts";
import { applyColor, formatTokens, rainbow, resolveIcons, withIcon, DEFAULT_COLORS, type ThemeLike } from "./ui.ts";

interface RenderedSegment {
	text: string;
	visible: boolean;
}

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}

const HIDDEN: RenderedSegment = { text: "", visible: false };
const THINKING_LABELS: Record<string, string> = { minimal: "min", medium: "med" };
const RAINBOW_LEVELS = new Set(["high", "xhigh", "max"]);

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	const icons = resolveIcons(config.icons);

	let ctx: ExtensionContext | null = null;
	let requestRender: (() => void) | null = null;

	// TPS state for the assistant message currently streaming (or the last
	// completed one; frozen until the next message starts).
	let streamStartMs = 0;
	let liveTps: number | null = null;

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		if (!c.hasUI || typeof c.ui.setFooter !== "function") return;
		initVibes(c, config.vibes, c.ui.theme);
		c.ui.setFooter((tui, theme: ThemeLike, footerData: FooterData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render: (width: number): string[] => renderFooter(width, theme, footerData),
			};
		});
	});

	pi.on("model_select", async (_event, c) => {
		ctx = c;
		requestRender?.();
	});
	pi.on("thinking_level_select", async (_event, c) => {
		ctx = c;
		requestRender?.();
	});
	pi.on("session_tree", async (_event, c) => {
		ctx = c;
		liveTps = null;
		requestRender?.();
	});

	// Vibes lifecycle.
	pi.on("before_agent_start", async (event, c) => {
		ctx = c;
		if (c.hasUI) onVibeBeforeAgentStart(event.prompt, c.ui.setWorkingMessage);
	});
	pi.on("agent_start", async (_event, c) => {
		ctx = c;
		onVibeAgentStart();
	});
	pi.on("agent_end", async (_event, c) => {
		ctx = c;
		if (c.hasUI) onVibeAgentEnd(c.ui.setWorkingMessage);
	});

	// TPS: output tokens of the current assistant message divided by its
	// elapsed streaming time. Hidden until 1s has passed (startup spike).
	pi.on("message_start", async (event, c) => {
		ctx = c;
		if (event.message?.role === "assistant") {
			streamStartMs = Date.now();
			liveTps = null;
		}
	});
	pi.on("message_update", async (event, c) => {
		ctx = c;
		if (event.message?.role !== "assistant" || !streamStartMs) return;
		const output = event.message.usage?.output ?? 0;
		const elapsedSec = (Date.now() - streamStartMs) / 1000;
		if (output > 0 && elapsedSec >= 1) {
			liveTps = output / elapsedSec;
			requestRender?.();
		}
	});
	pi.on("message_end", async (event, c) => {
		ctx = c;
		if (event.message?.role !== "assistant" || !streamStartMs) return;
		const output = event.message.usage?.output ?? 0;
		const elapsedSec = (Date.now() - streamStartMs) / 1000;
		liveTps = output > 0 && elapsedSec > 0 ? output / elapsedSec : null;
		streamStartMs = 0;
		requestRender?.();
	});

	function segmentColor(id: SegmentId): string {
		return config.colors[id] ?? DEFAULT_COLORS[id];
	}

	function readContextUsage(): { tokens: number | null; window: number; percent: number | null } {
		const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
		const record = isRecord(usage) ? usage : null;
		const window =
			typeof record?.contextWindow === "number" && Number.isFinite(record.contextWindow) && record.contextWindow > 0
				? record.contextWindow
				: (ctx?.model?.contextWindow ?? 0);
		const tokens =
			record?.tokens === null || typeof record?.tokens === "number"
				? (record.tokens as number | null)
				: null;
		if (tokens === null || window <= 0) return { tokens: null, window, percent: null };
		const percent =
			typeof record?.percent === "number" && Number.isFinite(record.percent)
				? record.percent
				: (tokens / window) * 100;
		return { tokens, window, percent };
	}

	function lastAssistantUsage(): UsageLike | null {
		const branch = ctx?.sessionManager?.getBranch?.();
		if (!Array.isArray(branch)) return null;
		for (let i = branch.length - 1; i >= 0; i -= 1) {
			const entry = branch[i];
			if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
			const message = entry.message;
			if (message.role !== "assistant" || !isRecord(message.usage)) continue;
			const u = message.usage;
			if (
				typeof u.input === "number" && typeof u.output === "number"
				&& typeof u.cacheRead === "number" && typeof u.cacheWrite === "number"
			) {
				return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
			}
		}
		return null;
	}

	function renderSegment(id: SegmentId, theme: ThemeLike, footerData: FooterData): RenderedSegment {
		switch (id) {
			case "model": {
				const raw = ctx?.model?.name || ctx?.model?.id || "no-model";
				const text = withIcon(icons.model, raw.toLowerCase());
				return { text: applyColor(theme, segmentColor("model"), text), visible: true };
			}
			case "thinking": {
				if (!ctx?.model?.reasoning) return HIDDEN;
				const level = ctx.thinkingLevel || "off";
				if (level === "off") return HIDDEN;
				const label = THINKING_LABELS[level] ?? level;
				const text = withIcon(icons.thinking, label);
				const colored = RAINBOW_LEVELS.has(level)
					? rainbow(text)
					: applyColor(theme, segmentColor("thinking"), text);
				return { text: colored, visible: true };
			}
			case "path": {
				const cwd = ctx?.cwd ?? process.cwd();
				const text = withIcon(icons.path, basename(cwd) || cwd);
				return { text: applyColor(theme, segmentColor("path"), text), visible: true };
			}
			case "git": {
				const branch = footerData.getGitBranch();
				if (!branch) return HIDDEN;
				return { text: applyColor(theme, segmentColor("git"), withIcon(icons.git, branch)), visible: true };
			}
			case "context": {
				const { tokens, window, percent } = readContextUsage();
				const text = tokens !== null && percent !== null
					? `${formatTokens(tokens)}/${formatTokens(window)} (${percent.toFixed(1)}%)`
					: `?/${formatTokens(window)}`;
				let color = segmentColor("context");
				if (percent !== null && percent > 90) color = "error";
				else if (percent !== null && percent > 70) color = "warning";
				return { text: applyColor(theme, color, withIcon(icons.context, text)), visible: true };
			}
			case "tps": {
				if (liveTps === null || !Number.isFinite(liveTps) || liveTps <= 0) return HIDDEN;
				const text = withIcon(icons.tps, `${Math.round(liveTps)} tok/s`);
				return { text: applyColor(theme, segmentColor("tps"), text), visible: true };
			}
			case "cache_rate": {
				const usage = lastAssistantUsage();
				if (!usage) return HIDDEN;
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				if (promptTokens <= 0 || !(usage.cacheRead > 0 || usage.cacheWrite > 0)) return HIDDEN;
				const percent = (usage.cacheRead / promptTokens) * 100;
				return { text: applyColor(theme, segmentColor("cache_rate"), withIcon(icons.cache_rate, `${Math.round(percent)}%`)), visible: true };
			}
		}
	}

	function renderStatusesLine(width: number, theme: ThemeLike, footerData: FooterData): string | null {
		const statuses = footerData.getExtensionStatuses();
		if (!statuses || statuses.size === 0) return null;
		const parts = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
			.filter(Boolean);
		if (parts.length === 0) return null;
		return truncateToWidth(parts.join(" "), width, theme.fg("dim", "..."));
	}

	function renderFooter(width: number, theme: ThemeLike, footerData: FooterData): string[] {
		try {
			const left = config.left
				.map((id) => renderSegment(id, theme, footerData))
				.filter((s) => s.visible)
				.map((s) => s.text)
				.join(" / ");
			const right = config.right
				.map((id) => renderSegment(id, theme, footerData))
				.filter((s) => s.visible)
				.map((s) => s.text)
				.join("  ");

			const leftWidth = visibleWidth(left);
			const rightWidth = visibleWidth(right);
			let line: string;
			if (leftWidth > width) {
				line = truncateToWidth(left, width, "...");
			} else {
				const availableForRight = width - leftWidth - 2;
				const rightText = rightWidth > availableForRight
					? truncateToWidth(right, Math.max(0, availableForRight), "")
					: right;
				const pad = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(rightText)));
				line = left + pad + rightText;
			}

			const lines = [line];
			const statuses = renderStatusesLine(width, theme, footerData);
			if (statuses) lines.push(statuses);
			return lines;
		} catch (error) {
			console.debug("[pi-light-statusline] Footer render failed:", error);
			return ["pi-light-statusline: render error"];
		}
	}
}
