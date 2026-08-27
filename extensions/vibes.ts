// AI-generated themed working messages ("vibes"), ported from
// pi-powerline-footer's working-vibes with the file mode, per-tool-call
// refresh, and settings persistence removed: one generation per agent run.
//
// Flow: before_agent_start sets a placeholder, then fires an LLM call with a
// timeout. On success the working message is replaced; on failure/timeout the
// fallback stays. {exclude} is filled with recent vibes to avoid repetition.

import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VibesConfig } from "./config.ts";
import { applyColor, rainbow, type ThemeLike } from "./ui.ts";

const VIBE_SYSTEM_PROMPT = "You generate short themed loading messages and reply with the requested text only.";
const MAX_RECENT_VIBES = 5;
const NOT_STREAMING_SENTINEL = 0;

let extensionCtx: ExtensionContext | null = null;
let vibeConfig: VibesConfig | null = null;
let vibeTheme: ThemeLike | null = null;
let currentGeneration: AbortController | null = null;
let recentVibes: string[] = [];
let streamingSince = NOT_STREAMING_SENTINEL;

export function initVibes(ctx: ExtensionContext, config: VibesConfig, theme: ThemeLike): void {
	extensionCtx = ctx;
	vibeConfig = config;
	vibeTheme = theme;
}

export function onVibeAgentStart(): void {
	streamingSince = Date.now();
}

export function onVibeAgentEnd(setWorkingMessage: (msg?: string) => void): void {
	streamingSince = NOT_STREAMING_SENTINEL;
	currentGeneration?.abort();
	currentGeneration = null;
	setWorkingMessage(undefined);
}

export function onVibeBeforeAgentStart(prompt: string, setWorkingMessage: (msg?: string) => void): void {
	if (!vibeConfig?.enabled || !vibeConfig.theme) return;
	setStyled(setWorkingMessage, `${vibeConfig.fallback}...`);
	void generateAndUpdate(prompt, setWorkingMessage);
}

function setStyled(setWorkingMessage: (msg?: string) => void, message?: string): void {
	if (!message || !vibeConfig?.color || !vibeTheme) {
		setWorkingMessage(message);
		return;
	}
	setWorkingMessage(
		vibeConfig.color === "rainbow"
			? rainbow(message)
			: applyColor(vibeTheme, vibeConfig.color, message),
	);
}

function buildPrompt(theme: string, task: string, config: VibesConfig): string {
	return config.prompt
		.replaceAll("{theme}", theme)
		.replaceAll("{task}", task)
		.replaceAll("{exclude}", recentVibes.length > 0 ? recentVibes.join(" / ") : "none")
		.replaceAll("{maxLength}", String(config.maxLength));
}

export function parseVibeResponse(response: string, fallback: string, maxLength: number): string {
	if (!response) return `${fallback}...`;

	// Take only the first line (the model sometimes adds explanations).
	let vibe = response.trim().split("\n")[0]!.trim();

	// Remove quotes if the model wrapped its reply.
	vibe = vibe.replace(/^["']|["']$/g, "");

	// Ensure ellipsis.
	if (!vibe.endsWith("...")) {
		vibe = vibe.replace(/\.+$/, "") + "...";
	}

	// Enforce length limit.
	if (vibe.length > maxLength) {
		vibe = vibe.slice(0, maxLength - 3) + "...";
	}

	if (!vibe || vibe === "...") return `${fallback}...`;
	return vibe;
}

// Extension-registered providers live in the model registry only: their custom
// `api` values are absent from pi-ai's global api table, so streaming has to go
// through the provider itself with a credential-resolved baseUrl.
async function completeVibe(
	providerId: string,
	model: Model<string>,
	context: Context,
	options: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const registry = extensionCtx?.modelRegistry;
	const provider = registry?.getProvider(providerId);
	if (!registry || !provider) {
		throw new Error(`Provider not registered: ${providerId}`);
	}
	const baseUrl = (await registry.getProviderAuth(providerId))?.auth.baseUrl;
	const requestModel = baseUrl ? { ...model, baseUrl } : model;
	return provider.stream(requestModel, context, options).result();
}

async function generateVibe(task: string, signal: AbortSignal): Promise<string> {
	const config = vibeConfig;
	const ctx = extensionCtx;
	if (!config || !ctx) return `${config?.fallback ?? "Working"}...`;

	const slashIndex = config.model.indexOf("/");
	if (slashIndex === -1) return `${config.fallback}...`;
	const providerId = config.model.slice(0, slashIndex);
	const modelId = config.model.slice(slashIndex + 1);
	if (!providerId || !modelId) return `${config.fallback}...`;

	const model = ctx.modelRegistry.find(providerId, modelId);
	if (!model) {
		console.debug(`[pi-light-statusline] Vibe model not found: ${config.model}`);
		return `${config.fallback}...`;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		console.debug(`[pi-light-statusline] Vibe auth failed for ${providerId}: ${auth.error}`);
		return `${config.fallback}...`;
	}

	const context: Context = {
		systemPrompt: VIBE_SYSTEM_PROMPT,
		messages: [{
			role: "user",
			content: [{ type: "text", text: buildPrompt(config.theme, task, config) }],
			timestamp: Date.now(),
		}],
	};
	const response = await completeVibe(providerId, model, context, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
	});

	const text = response.content.find((c) => c.type === "text")?.text || "";
	return parseVibeResponse(text, config.fallback, config.maxLength);
}

async function generateAndUpdate(prompt: string, setWorkingMessage: (msg?: string) => void): Promise<void> {
	const config = vibeConfig;
	if (!config) return;

	// Cancel any in-flight generation; keep a local reference so a superseded
	// run can never overwrite the working message of a newer run.
	const controller = new AbortController();
	currentGeneration?.abort();
	currentGeneration = controller;

	const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
	const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

	try {
		const vibe = await generateVibe(prompt, combinedSignal);
		const isFallback = vibe === `${config.fallback}...`;
		if (streamingSince !== NOT_STREAMING_SENTINEL && !controller.signal.aborted) {
			if (!isFallback) {
				recentVibes = [vibe, ...recentVibes.filter((v) => v !== vibe)].slice(0, MAX_RECENT_VIBES);
			}
			setStyled(setWorkingMessage, vibe);
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			// Timeout or superseded: the fallback placeholder is already showing.
			console.debug("[pi-light-statusline] Vibe generation aborted");
		} else {
			console.debug("[pi-light-statusline] Vibe generation failed:", error);
		}
	}
}
