# openclaw-langfuse

OpenClaw plugin that sends agent traces to a self-hosted [Langfuse](https://langfuse.com) instance. No npm packages required — uses the Langfuse REST API directly via native `fetch`.

**This fork fixes critical issues in the original plugin:**

1. **Token tracking** — Original shows 0 tokens for all traces. Fixed by using the `llm_output` hook which exposes real usage data from OpenClaw's internal accumulator.
2. **Model name** — Original shows `None`. Fixed by capturing `model` from `llm_output`.
3. **Race condition** — `agent_end` fires ~10ms *before* `llm_output` in OpenClaw's hook execution order. The original plugin tries to read token data in `agent_end`, but the data doesn't exist yet. This fork uses a two-phase approach: create the generation in `agent_end`, then update it with token data when `llm_output` fires.
4. **File-based key fallback** — OpenClaw regenerates its launchd plist on `gateway restart`, which blows away manually-set environment variables. This fork reads keys from `~/.openclaw/secrets/langfuse-keys.env` as a fallback when env vars aren't set.

## What you get in Langfuse

After installing, every agent turn shows:

- **Model name** (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`)
- **Provider** (e.g., `anthropic`, `openai`)
- **Token usage** — `input`, `output`, `total` (real numbers, not zeros)
- **Tool call count** — how many tool calls the agent made
- **Assistant message count** — how many responses the agent generated
- **Input/output text** — first 2000/4000 chars of prompt and response
- **Duration** — wall-clock time for the full turn
- **Session grouping** — traces grouped by OpenClaw session key

## Architecture

```
before_agent_start          agent_end                 llm_output
     │                          │                         │
     │ capture prompt +         │ create trace +          │ update generation
     │ start time               │ generation (no tokens)  │ with model + tokens
     │                          │                         │
     ▼                          ▼                         ▼
  pendingTurns.set()      sendBatch([trace-create,    sendBatch([generation-update])
                          generation-create])
                                │                         │
                                │  generationId stored    │  reads generationId
                                │  in pendingTurns        │  from pendingTurns
                                ▼                         ▼
                          Langfuse receives         Langfuse patches the
                          trace + generation        generation with real data
                          (model=null, tokens=0)    (model=opus, tokens=748K)
```

**Why two phases?** OpenClaw's hook execution order is: `agent_end` → `llm_output` (not the other way around). By the time `llm_output` fires with token data, `agent_end` has already finished. The solution: `agent_end` creates the Langfuse objects with a known ID, and `llm_output` updates them ~10ms later.

## Setup

### 1. Self-host Langfuse

Follow the [Langfuse self-hosting guide](https://langfuse.com/docs/deployment/self-host). Docker Compose is the easiest path.

### 2. Create API keys

In Langfuse dashboard → Settings → API Keys → Create. You need the **Public Key** and **Secret Key**.

### 3. Store keys

Create `~/.openclaw/secrets/langfuse-keys.env` with `600` permissions:

```bash
mkdir -p ~/.openclaw/secrets
cat > ~/.openclaw/secrets/langfuse-keys.env << 'EOF'
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxx
EOF
chmod 600 ~/.openclaw/secrets/langfuse-keys.env
```

### 4. Install the plugin

```bash
# Clone into OpenClaw's extensions directory
git clone https://github.com/abhilash710/openclaw-langfuse.git ~/.openclaw/extensions/langfuse-tracer

# Copy plugin files to the right location (the repo nests them in langfuse-tracer/)
cp ~/.openclaw/extensions/langfuse-tracer/langfuse-tracer/index.js ~/.openclaw/extensions/langfuse-tracer/index.js
cp ~/.openclaw/extensions/langfuse-tracer/langfuse-tracer/openclaw.plugin.json ~/.openclaw/extensions/langfuse-tracer/openclaw.plugin.json

# Restart the gateway
openclaw gateway restart
```

Check the gateway logs for: `[langfuse-tracer] v3 enabled → http://localhost:3000`

### 5. Verify

After a few turns, check Langfuse dashboard. You should see traces with real model names and token counts. If you see `tokenUpdateApplied: true` in the generation metadata, the two-phase update is working.

## Configuration

The plugin reads keys in this order:
1. Environment variables: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`
2. File fallback: `~/.openclaw/secrets/langfuse-keys.env`
3. Base URL defaults to `http://localhost:3000`

## Gotchas

- **OpenClaw regenerates its launchd plist on `gateway restart`.** Any env vars you set manually will be lost. Use the file-based key approach above.
- **Docker must be running** for Langfuse to work. If Langfuse is down, the plugin fails silently (no crash, just no traces).
- **Cron sessions** (isolated) are traced with their cron session key, making them visible alongside main session traces.
- **Token counts include cache reads.** The `total` field includes `cacheRead` tokens (prompt caching). The `input` field is the actual new input tokens sent to the model. For a long conversation, `total` can be very large (1M+) while `input` is tiny (5-10).

## OpenClaw Hook Reference

For plugin developers — the hooks this plugin uses:

| Hook | When it fires | Key fields |
|------|--------------|------------|
| `before_agent_start` | Before the agent turn begins | `event.prompt` |
| `agent_end` | When the turn completes (fires FIRST) | `event.messages`, `event.success`, `event.durationMs`, `event.error` |
| `llm_output` | After the LLM response (fires SECOND, ~10ms after agent_end) | `event.model`, `event.provider`, `event.usage`, `event.assistantTexts`, `event.lastAssistant` |

The `llm_output.usage` object: `{ input, output, cacheRead, cacheWrite, total }` — accumulated across the full turn by OpenClaw's internal `recordAssistantUsage()`.

## License

MIT (same as original)

## Credits

Original plugin by [Matt Kruczek](https://github.com/MCKRUZ/openclaw-langfuse).
Token tracking fix, race condition solution, and file-based key fallback by [abhilash710](https://github.com/abhilash710).
