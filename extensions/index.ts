// pi-light-statusline: a lightweight replacement for pi's built-in footer.
//
// Official-style layout (left stats, right-aligned model + thinking level,
// extension statuses on their own line below), with colors, icons, live tok/s
// and cache-hit rate. Optional AI-generated working vibes.
//
// Segment ids and all options are configured via the "lightStatusline" block
// in ~/.pi/agent/settings.json; see config.ts for the schema.

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
	// elapsed streaming time. Sticks between messages (never reset to null on
	// message_start) so the footer never flickers empty between turns.
	function updateTps(message: unknown, minElapsedSec: number): void {
		if (!isRecord(message) || message.role !== "assistant" || !streamStartMs) return;
		const usage = isRecord(message.usage) ? message.usage : null;
		const output = typeof usage?.output === "number" ? usage.output : 0;
		const elapsedSec = (Date.now() - streamStartMs) / 1000;
		if (output > 0 && elapsedSec >= minElapsedSec) {
			// ponytail: clamp raw ratio; a streaming hiccup can report huge spikes.
			liveTps = Math.min(output / elapsedSec, 9999);
			requestRender?.();
		}
	}

	pi.on("message_start", async (event, c) => {
		ctx = c;
		if (isRecord(event.message) && event.message.role === "assistant") {
			streamStartMs = Date.now();
		}
	});
	pi.on("message_update", async (event, c) => {
		ctx = c;
		updateTps(event.message, 1);
	});
	pi.on("message_end", async (event, c) => {
		ctx = c;
		if (!isRecord(event.message) || event.message.role !== "assistant" || !streamStartMs) return;
		updateTps(event.message, 1);
		streamStartMs = 0;
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
				// Full path like the built-in footer: ~-abbreviated home, plain elsewhere.
				const cwd = ctx?.cwd ?? process.cwd();
				const home = process.env.HOME || process.env.USERPROFILE;
				const path = home && (cwd === home || cwd.startsWith(`${home}/`))
					? `~${cwd.slice(home.length)}`
					: cwd;
				return { text: applyColor(theme, segmentColor("path"), withIcon(icons.path, path)), visible: true };
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
				// Always visible: 0 tok/s until the first assistant message finishes.
				const tps = liveTps !== null && Number.isFinite(liveTps) && liveTps > 0 ? Math.round(liveTps) : 0;
				const text = withIcon(icons.tps, `${tps} tok/s`);
				return { text: applyColor(theme, segmentColor("tps"), text), visible: true };
			}
			case "cache_rate": {
				// Always visible: Cache 0% until a turn reports usage.
				const usage = lastAssistantUsage();
				const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
				const percent = promptTokens > 0 ? (usage!.cacheRead / promptTokens) * 100 : 0;
				const text = withIcon(icons.cache_rate, `Cache ${Math.round(percent)}%`);
				return { text: applyColor(theme, segmentColor("cache_rate"), text), visible: true };
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
			const line1Left = config.line1
				.map((id) => renderSegment(id, theme, footerData))
				.filter((s) => s.visible)
				.map((s) => s.text)
				.join("  ");
			const line2Left = config.line2
				.map((id) => renderSegment(id, theme, footerData))
				.filter((s) => s.visible)
				.map((s) => s.text)
				.join(" ");
			const line2Right = config.right
				.map((id) => renderSegment(id, theme, footerData))
				.filter((s) => s.visible)
				.map((s) => s.text)
				.join("  ");

			// Line 2 mirrors the built-in footer: stats left, right-aligned model,
			// truncate the right side first, then the left overflow.
			const l2LeftWidth = visibleWidth(line2Left);
			let line2: string;
			if (l2LeftWidth > width) {
				line2 = truncateToWidth(line2Left, width, "...");
			} else {
				const availableForRight = width - l2LeftWidth - 2;
				const rightText = visibleWidth(line2Right) > availableForRight
					? truncateToWidth(line2Right, Math.max(0, availableForRight), "")
					: line2Right;
				const pad = " ".repeat(Math.max(0, width - l2LeftWidth - visibleWidth(rightText)));
				line2 = line2Left + pad + rightText;
			}

			const lines = [truncateToWidth(line1Left, width, "..."), line2];
			const statuses = renderStatusesLine(width, theme, footerData);
			if (statuses) lines.push(statuses);
			return lines;
		} catch (error) {
			console.debug("[pi-light-statusline] Footer render failed:", error);
			return ["pi-light-statusline: render error"];
		}
	}
}
