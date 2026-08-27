// Configuration loading and normalization for pi-light-statusline.
//
// All configuration lives in a single "lightStatusline" block of the pi agent
// settings file (~/.pi/agent/settings.json). Unknown fields and invalid
// segment ids are dropped silently; missing fields fall back to defaults.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEGMENT_IDS = [
	"model",
	"thinking",
	"path",
	"git",
	"context",
	"tps",
	"cache_rate",
] as const;

export type SegmentId = (typeof SEGMENT_IDS)[number];

export interface VibesConfig {
	enabled: boolean;
	theme: string;
	/** "provider/modelId" spec of the model used to generate vibes. */
	model: string;
	fallback: string;
	/** Prompt template; supports {theme}, {task}, {exclude}, {maxLength}. */
	prompt: string;
	maxLength: number;
	timeoutMs: number;
	/** Semantic color name, #hex, or "rainbow"; empty = unstyled. */
	color: string;
}

export interface StatuslineConfig {
	line1: SegmentId[];
	line2: SegmentId[];
	right: SegmentId[];
	colors: Partial<Record<SegmentId, string>>;
	icons: Partial<Record<SegmentId, string>>;
	vibes: VibesConfig;
}

export const DEFAULT_LINE1: SegmentId[] = ["path", "git"];
export const DEFAULT_LINE2: SegmentId[] = ["context", "tps", "cache_rate"];
export const DEFAULT_RIGHT: SegmentId[] = ["model", "thinking"];

export const DEFAULT_VIBES_PROMPT = `Generate a 2-4 word "{theme}" themed loading message ending in "...".

Task: {task}

Be creative and unexpected. Avoid obvious or clichéd phrases for this theme.
The message should hint at the task using theme vocabulary.
Recent messages to avoid repeating: {exclude}
Keep it under {maxLength} characters.
Output only the message, nothing else.`;

const DEFAULT_VIBES_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_VIBES_FALLBACK = "Working";
const DEFAULT_VIBES_MAX_LENGTH = 65;
const DEFAULT_VIBES_TIMEOUT_MS = 3000;

function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	return configured && configured.trim() ? configured.trim() : join(home, ".pi", "agent");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSegmentList(value: unknown, fallback: SegmentId[]): SegmentId[] {
	if (!Array.isArray(value)) return [...fallback];
	const valid = new Set<string>(SEGMENT_IDS);
	const ids = value.filter((id): id is SegmentId => typeof id === "string" && valid.has(id));
	return [...new Set(ids)];
}

/** Assign ids to line1/line2/right: explicit arrays win, missing ones fall back to defaults. */
function normalizeLayout(raw: Record<string, unknown>): Pick<StatuslineConfig, "line1" | "line2" | "right"> {
	const explicitLine1 = Array.isArray(raw.line1) ? normalizeSegmentList(raw.line1, DEFAULT_LINE1) : null;
	const explicitLine2 = Array.isArray(raw.line2) ? normalizeSegmentList(raw.line2, DEFAULT_LINE2) : null;
	const explicitRight = Array.isArray(raw.right) ? normalizeSegmentList(raw.right, DEFAULT_RIGHT) : null;
	const hasLegacy = Array.isArray(raw.left) || Array.isArray(raw.right);
	if (!hasLegacy) {
		// Fresh config (or partial): defaults fill whatever was not provided.
		return {
			line1: explicitLine1 ?? [...DEFAULT_LINE1],
			line2: explicitLine2 ?? [...DEFAULT_LINE2],
			right: explicitRight ?? [...DEFAULT_RIGHT],
		};
	}
	if (explicitLine1 && explicitLine2) {
		return { line1: explicitLine1, line2: explicitLine2, right: explicitRight ?? [...DEFAULT_RIGHT] };
	}
	// Legacy single-line shape: split the old left list so stats go to line 2
	// and path/git stay on line 1, like the built-in footer.
	const legacy = Array.isArray(raw.left) ? normalizeSegmentList(raw.left, DEFAULT_LINE1) : DEFAULT_LINE1;
	const line1 = explicitLine1 ?? legacy.filter((id) => id === "path" || id === "git");
	const line2 = explicitLine2 ?? legacy.filter((id) => id !== "path" && id !== "git");
	return { line1, line2, right: explicitRight ?? [...DEFAULT_RIGHT] };
}

function normalizeStringMap(value: unknown, validKeys: readonly string[]): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const key of validKeys) {
		const raw = value[key];
		if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
	}
	return out;
}

function normalizeVibes(value: unknown): VibesConfig {
	const v = isRecord(value) ? value : {};
	return {
		enabled: v.enabled === true,
		theme: typeof v.theme === "string" ? v.theme : "",
		model: typeof v.model === "string" && v.model.includes("/") ? v.model : DEFAULT_VIBES_MODEL,
		fallback: typeof v.fallback === "string" && v.fallback.trim() ? v.fallback : DEFAULT_VIBES_FALLBACK,
		prompt: typeof v.prompt === "string" && v.prompt.trim() ? v.prompt : DEFAULT_VIBES_PROMPT,
		maxLength:
			typeof v.maxLength === "number" && Number.isFinite(v.maxLength) && v.maxLength >= 4
				? Math.floor(v.maxLength)
				: DEFAULT_VIBES_MAX_LENGTH,
		timeoutMs:
			typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs) && v.timeoutMs >= 500
				? Math.floor(v.timeoutMs)
				: DEFAULT_VIBES_TIMEOUT_MS,
		color: typeof v.color === "string" ? v.color.trim() : "",
	};
}

export function normalizeConfig(raw: unknown): StatuslineConfig {
	const v = isRecord(raw) ? raw : {};
	const layout = normalizeLayout(v);
	return {
		...layout,
		colors: normalizeStringMap(v.colors, SEGMENT_IDS) as Partial<Record<SegmentId, string>>,
		icons: normalizeStringMap(v.icons, SEGMENT_IDS) as Partial<Record<SegmentId, string>>,
		vibes: normalizeVibes(v.vibes),
	};
}

export function loadConfig(): StatuslineConfig {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return normalizeConfig(undefined);
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		return normalizeConfig(isRecord(parsed) ? parsed.lightStatusline : undefined);
	} catch (error) {
		console.debug("[pi-light-statusline] Failed to load config:", error);
		return normalizeConfig(undefined);
	}
}
