# LLM Provider Guide

MonoBot now has three provider lanes:

- `gemini` / `google`: the native Gemini provider.
- `nvidia` / `kimi`: the NVIDIA NIM provider.
- OpenAI-compatible chat completions: `openai-compatible`, `openai`, `openrouter`, `groq`, `cerebras`, `mistral`, `deepinfra`, `together`, `github`, `cloudflare`, `lmstudio`, and `ollama`.

The OpenAI-compatible lane is the flexible one. If a provider exposes a `/chat/completions` endpoint with OpenAI-style messages and tool calls, the core chat and tool loop should work after setting `AI_PROVIDER`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, and an API key.

## Practical Caveat

This does not mean every model on every provider is equal. The bot's task flow depends on tool calling. Models that do not support OpenAI-style `tool_calls`, return malformed tool arguments, or ignore tool instructions can still chat, but they will not reliably run Discord/server/music/admin tools.

Gemini-specific side paths may still require Gemini keys, including native Gemini media features and any direct `client.models.generateContent(...)` call that intentionally bypasses the provider abstraction. The main chat brain and task/tool execution path is provider-swappable.

## Fast Starts

### Groq

```env
AI_PROVIDER=groq
GROQ_API_KEY=your_key_here
OPENAI_COMPAT_MODEL=llama-3.3-70b-versatile
OPENAI_COMPAT_FAST_MODEL=llama-3.1-8b-instant
```

### OpenRouter

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENAI_COMPAT_MODEL=provider/model-id
OPENAI_COMPAT_HTTP_REFERER=https://your-site.example
OPENAI_COMPAT_APP_TITLE=MonoBot
```

OpenRouter free models change over time. In their model picker, prefer models labeled `:free` and verify that tool calling is supported before using them for the task-heavy bot flow.

### Cloudflare Workers AI

```env
AI_PROVIDER=cloudflare
CLOUDFLARE_API_TOKEN=your_token_here
OPENAI_COMPAT_BASE_URL=https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1
OPENAI_COMPAT_MODEL=@cf/meta/llama-3.1-8b-instruct
```

### Local LM Studio

```env
AI_PROVIDER=lmstudio
OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
OPENAI_COMPAT_MODEL=local-model
OPENAI_COMPAT_ALLOW_NO_API_KEY=1
```

### Local Ollama

```env
AI_PROVIDER=ollama
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1
OPENAI_COMPAT_MODEL=llama3.1
OPENAI_COMPAT_ALLOW_NO_API_KEY=1
```

## Free Or Free-Tier Options To Try

- Gemini API: has a documented free tier for developers and small projects. Use `AI_PROVIDER=gemini` for native mode, or Gemini's OpenAI-compatible endpoint if you want to test through the compatibility lane.
- Groq: has OpenAI-compatible endpoints and published rate-limit docs. Good first choice for fast free-tier experimentation.
- OpenRouter: supports chat completions and commonly lists free models. Tool support varies by model, so test a task command before committing.
- Cloudflare Workers AI: has a daily free allocation and an OpenAI-compatible endpoint.
- GitHub Models: useful for experimentation with model swapping through GitHub's model platform.
- Hugging Face Inference Providers: has free monthly credits for HF users, but provider/model behavior varies.
- Cerebras: offers a free API key path and OpenAI-compatible chat completion style APIs.
- Local LM Studio or Ollama: free to call locally after you run a model, but quality and tool calling depend on the local model.

## Source Links

- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Groq OpenAI compatibility: https://console.groq.com/docs/openai
- Groq rate limits: https://console.groq.com/docs/rate-limits
- OpenRouter chat completions: https://openrouter.ai/docs/api-reference/chat-completion
- Cloudflare Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare OpenAI-compatible endpoints: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- Hugging Face Inference Providers pricing: https://huggingface.co/docs/inference-providers/pricing
- GitHub Models: https://docs.github.com/en/github-models
- Cerebras quickstart: https://inference-docs.cerebras.ai/quickstart
