import type { Api, Model } from "@earendil-works/pi-ai";

const LOCAL_PROVIDERS = new Set(["local", "llama.cpp"]);
const LOCAL_HOST = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(:\d+)?(\/|$)/i;

/**
 * Whether the qwen-local profile applies to `model`.
 *
 * `PI_QWEN_PROFILE=0|off` disables it everywhere; `1|on` forces it for any
 * openai-completions model. Otherwise it activates for the local providers
 * ("local", "llama.cpp") and for any model id containing "qwen" that is served
 * from a local host, as long as the wire format is openai-completions. Cloud
 * Qwen endpoints are left alone unless forced.
 */
export function isQwenLocalActive(
	model: Model<Api> | undefined,
	profile: string | undefined = process.env.PI_QWEN_PROFILE,
): boolean {
	if (!model || model.api !== "openai-completions") return false;
	const setting = profile?.trim().toLowerCase();
	if (setting === "0" || setting === "off") return false;
	if (setting === "1" || setting === "on") return true;
	return LOCAL_PROVIDERS.has(model.provider) || (/qwen/i.test(model.id) && LOCAL_HOST.test(model.baseUrl));
}
