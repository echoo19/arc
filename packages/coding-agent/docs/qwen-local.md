# qwen-local profile

Pi ships a hidden built-in extension, `qwen-local`, that tunes the agent for Qwen models served locally through an OpenAI-compatible endpoint (llama.cpp `llama-server`, and similar). It changes nothing for other models.

## Activation

The profile is evaluated per hook from the current model:

- The model API must be `openai-completions`.
- The provider is `local` or `llama.cpp`, or the model id contains `qwen` (case-insensitive).

`PI_QWEN_PROFILE` overrides the model check:

| Value | Effect |
|---|---|
| unset | automatic (rules above) |
| `1` / `on` | force on for any `openai-completions` model |
| `0` / `off` | force off |

## What it changes

Only while active:

- **System prompt.** Replaces the default prompt with a compact one (~450 tokens before project context): tool list, a four-step read/change/verify/finish workflow, and tool-use rules. Project context files (`AGENTS.md`), skills, `--append-system-prompt` and the cwd line are still appended. If you pass your own `--system-prompt` (or `SYSTEM.md`), it is left untouched. Tool `promptGuidelines` are not included. The prompt contains no session-specific values so the llama.cpp prefix cache stays warm across turns.
- **Request body.** Sets `chat_template_kwargs.enable_thinking` from the pi thinking level (`/thinking off` disables Qwen thinking) with `preserve_thinking: false`; sets `thinking_budget_tokens` per level (minimal 512, low 1024, medium 3072, high 6144, xhigh/max 8192; clamped to `max_tokens - 1024`, minimum 256); fills Qwen's recommended sampling when the key is absent (thinking: temperature 0.6, top_p 0.95, top_k 20, min_p 0; non-thinking: temperature 0.7, top_p 0.8, top_k 20, min_p 0); drops `store` and `tools[].function.strict`. Any key already present, including everything from `samplingParams` in `models.json`, wins over these defaults. `presence_penalty` is not set; Qwen suggests 0-2 to curb repetition if you see it (`samplingParams: { "presence_penalty": 1.0 }`).
- **Tool calls.** Common argument-name mistakes are mapped onto the real schema when the canonical key is missing (`file_path`/`filename`/`file` to `path`; `cmd`/`script` to `command`; `text`/`contents` to `content`; `start_line`/`num_lines` to `offset`/`limit`; `old_string`/`new_string`, `search`/`replace`, etc. to `edits[].oldText`/`newText`). Bash gets a default `timeout` of 120 seconds. A loop guard blocks the third identical (tool, arguments) call within one user prompt and tells the model to change approach.
- **Empty stops.** If the model ends a run with `stop` but produced no text and no tool calls, a follow-up user message asks it to continue (at most twice per prompt).

## Recommended models.json

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "local",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "requiresToolResultName": true,
        "supportsStore": false,
        "supportsStrictMode": false
      },
      "models": [
        {
          "id": "qwen3.6-35b-a3b",
          "name": "Qwen3.6 35B-A3B (local)",
          "reasoning": true,
          "contextWindow": 32768,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Start `llama-server` with `--jinja` and `-c 32768` (see [llama.cpp](llama-cpp.md)). Sampling and thinking fields are applied by the extension per request, so no `thinkingFormat` or `samplingParams` is required; add `samplingParams` only to override the defaults above.
