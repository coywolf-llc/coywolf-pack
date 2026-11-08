/**
 * Model providers for AI Enrichment: Workers AI (through the AI binding) or a
 * bring-your-own key for Anthropic, OpenAI, or Google Gemini. One call shape
 * for text and vision; usage is reported where the provider gives it.
 * API keys are never logged or included in errors.
 */

export type ProviderId = "workers-ai" | "anthropic" | "openai" | "gemini";

export const PROVIDERS: Array<{ id: ProviderId; label: string; textModel: string; visionModel: string }> = [
	{ id: "workers-ai", label: "Cloudflare Workers AI", textModel: "@cf/meta/llama-4-scout-17b-16e-instruct", visionModel: "@cf/meta/llama-4-scout-17b-16e-instruct" },
	// Checked 2026-10-03 against each provider's model docs: Claude Haiku 4.5 is only committed through
	// Oct 15, 2026, so Sonnet 5.5 (through at least Sep 28, 2027) is the smallest Claude with a long runway;
	// Gemini 2.5 is closed to new keys, Google recommends 3.8 Flash; GPT-6 Luna is OpenAI's efficient model.
	{ id: "anthropic", label: "Anthropic (Claude)", textModel: "claude-sonnet-5-5", visionModel: "claude-sonnet-5-5" },
	{ id: "openai", label: "OpenAI", textModel: "gpt-6-luna", visionModel: "gpt-6-luna" },
	{ id: "gemini", label: "Google Gemini", textModel: "gemini-3.8-flash", visionModel: "gemini-3.8-flash" },
];

export const PROVIDER_HOSTS = ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"];

export interface ChatRequest {
	system: string;
	user: string;
	image?: { mimeType: string; base64: string };
	maxTokens: number;
}

export interface ChatResult {
	/** Raw text, or an already-parsed object (Workers AI JSON mode). */
	text: string;
	inputTokens: number;
	outputTokens: number;
}

export interface ProviderConfig {
	provider: ProviderId;
	model: string;
	apiKey: string;
	/** Workers AI binding (env.AI). */
	binding?: { run(model: string, input: unknown, options?: unknown): Promise<unknown> };
	/** fetch to use (the plugin's HTTP access when available). */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const TIMEOUT_MS = 90_000;

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

function redact(text: string, key: string): string {
	let out = text;
	if (key) out = out.split(key).join("[redacted]");
	return out.replace(/\s+/g, " ").slice(0, 300);
}

async function httpError(response: Response, key: string, label: string): Promise<ProviderError> {
	let detail = "";
	try {
		const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
		detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
	} catch {
		detail = "";
	}
	return new ProviderError(`${label} returned HTTP ${response.status}${detail ? `: ${redact(detail, key)}` : ""}`, response.status);
}

async function postJson(cfg: ProviderConfig, url: string, headers: Record<string, string>, body: unknown, label: string): Promise<unknown> {
	let response: Response;
	try {
		response = await cfg.fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new ProviderError(`${label} request failed: ${redact(String((error as Error)?.message ?? error), cfg.apiKey)}`);
	}
	if (!response.ok) throw await httpError(response, cfg.apiKey, label);
	return response.json();
}

async function workersAi(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
	if (!cfg.binding) throw new ProviderError("The Workers AI binding isn't configured. Add an \"ai\" binding to wrangler.jsonc (see docs/ai.md in the Coywolf Pack repository).");
	const content = req.image
		? [
				{ type: "text", text: req.user },
				{ type: "image_url", image_url: { url: `data:${req.image.mimeType};base64,${req.image.base64}` } },
			]
		: req.user;
	let result: unknown;
	try {
		result = await cfg.binding.run(cfg.model, {
			messages: [
				{ role: "system", content: req.system },
				{ role: "user", content },
			],
			max_tokens: req.maxTokens,
		});
	} catch (error) {
		throw new ProviderError(`Workers AI: ${redact(String((error as Error)?.message ?? error), "")}`);
	}
	const r = result as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: Array<{ message?: { content?: string } }> };
	const raw = r.response ?? r.choices?.[0]?.message?.content ?? "";
	return {
		text: typeof raw === "string" ? raw : JSON.stringify(raw),
		inputTokens: r.usage?.prompt_tokens ?? 0,
		outputTokens: r.usage?.completion_tokens ?? 0,
	};
}

async function anthropic(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
	const content: unknown[] = [];
	if (req.image) content.push({ type: "image", source: { type: "base64", media_type: req.image.mimeType, data: req.image.base64 } });
	content.push({ type: "text", text: req.user });
	const data = (await postJson(
		cfg,
		"https://api.anthropic.com/v1/messages",
		{ "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
		{ model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content }] },
		"Anthropic",
	)) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
	return {
		text: (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
		inputTokens: data.usage?.input_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
	};
}

async function openai(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
	const user = req.image
		? [
				{ type: "text", text: req.user },
				{ type: "image_url", image_url: { url: `data:${req.image.mimeType};base64,${req.image.base64}` } },
			]
		: req.user;
	const body: Record<string, unknown> = {
		model: cfg.model,
		max_completion_tokens: req.maxTokens,
		messages: [
			{ role: "system", content: req.system },
			{ role: "user", content: user },
		],
	};
	const headers = { authorization: `Bearer ${cfg.apiKey}` };
	let data: unknown;
	try {
		data = await postJson(cfg, "https://api.openai.com/v1/chat/completions", headers, body, "OpenAI");
	} catch (error) {
		// Some models reject max_completion_tokens; retry once with the legacy field.
		if (!(error instanceof ProviderError) || error.status !== 400 || !error.message.includes("max_completion_tokens")) throw error;
		const { max_completion_tokens, ...rest } = body;
		data = await postJson(cfg, "https://api.openai.com/v1/chat/completions", headers, { ...rest, max_tokens: max_completion_tokens }, "OpenAI");
	}
	const d = data as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
	return { text: d.choices?.[0]?.message?.content ?? "", inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 };
}

async function gemini(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
	const parts: unknown[] = [];
	if (req.image) parts.push({ inline_data: { mime_type: req.image.mimeType, data: req.image.base64 } });
	parts.push({ text: req.user });
	const data = (await postJson(
		cfg,
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
		{ "x-goog-api-key": cfg.apiKey },
		{
			systemInstruction: { parts: [{ text: req.system }] },
			contents: [{ role: "user", parts }],
			// Thinking models spend output tokens before answering; leave room.
			generationConfig: { maxOutputTokens: Math.max(4096, req.maxTokens) },
		},
		"Gemini",
	)) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
		usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
	};
	const text = (data.candidates?.[0]?.content?.parts ?? [])
		.filter((p) => typeof p.text === "string" && !p.thought)
		.map((p) => p.text)
		.join("");
	return { text, inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 };
}

/** Current hosted models may reason before answering, and that counts against the output limit; leave room. Billing is per token used. */
const MIN_OUTPUT_TOKENS = 4096;

export async function chat(cfg: ProviderConfig, input: ChatRequest): Promise<ChatResult> {
	if (cfg.provider !== "workers-ai" && !cfg.apiKey) throw new ProviderError("Add an API key for the selected AI provider on the AI page.");
	const req = cfg.provider === "workers-ai" ? input : { ...input, maxTokens: Math.max(MIN_OUTPUT_TOKENS, input.maxTokens) };
	switch (cfg.provider) {
		case "workers-ai":
			return workersAi(cfg, req);
		case "anthropic":
			return anthropic(cfg, req);
		case "openai":
			return openai(cfg, req);
		case "gemini":
			return gemini(cfg, req);
	}
}

// ── Model lists (for the settings page) ─────────────────────────

export interface ModelOption {
	id: string;
	label: string;
}

/** Workers AI text-generation models that accept images (curated; the binding has no list call). */
const WORKERS_AI_MODELS: ModelOption[] = [
	{ id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B (text + images)" },
	{ id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B (text + images)" },
	{ id: "@cf/google/gemma-3-12b-it", label: "Gemma 3 12B (text + images)" },
	{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B fast (text only)" },
];

/** OpenAI ids that aren't chat models (audio, images, embeddings, moderation, …). */
const OPENAI_SKIP = /(audio|realtime|tts|transcribe|whisper|dall-e|image|embedding|moderation|search|computer-use|babbage|davinci|instruct)/i;

/**
 * Models the saved key can use, newest first where the provider says.
 * The key is sent only to the provider and never returned or logged.
 */
export async function listModels(cfg: Pick<ProviderConfig, "provider" | "apiKey" | "fetch">): Promise<ModelOption[]> {
	const get = async (url: string, headers: Record<string, string>) => {
		const response = await cfg.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new ProviderError(`The provider answered ${response.status} when listing models.`, response.status);
		return (await response.json()) as Record<string, unknown>;
	};
	switch (cfg.provider) {
		case "workers-ai":
			return WORKERS_AI_MODELS;
		case "anthropic": {
			const out: ModelOption[] = [];
			let after: string | undefined;
			for (let page = 0; page < 5; page++) {
				const body = await get(`https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, {
					"x-api-key": cfg.apiKey,
					"anthropic-version": "2023-06-01",
				});
				const data = (body.data ?? []) as Array<{ id: string; display_name?: string }>;
				for (const m of data) out.push({ id: m.id, label: m.display_name ? `${m.display_name} (${m.id})` : m.id });
				if (!body.has_more || !data.length) break;
				after = data[data.length - 1].id;
			}
			return out;
		}
		case "openai": {
			const body = await get("https://api.openai.com/v1/models", { Authorization: `Bearer ${cfg.apiKey}` });
			const data = (body.data ?? []) as Array<{ id: string; created?: number }>;
			return data
				.filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !OPENAI_SKIP.test(m.id))
				.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
				.map((m) => ({ id: m.id, label: m.id }));
		}
		case "gemini": {
			const body = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": cfg.apiKey });
			const models = (body.models ?? []) as Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
			return models
				.filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/i.test(m.name))
				.map((m) => {
					const id = m.name.replace(/^models\//, "");
					return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
				});
		}
	}
}
