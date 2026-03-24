/**
 * langfuse-tracer v3 — OpenClaw plugin
 *
 * Architecture: agent_end fires BEFORE llm_output (race condition).
 * Solution: agent_end creates the trace + generation with a known ID.
 *           llm_output fires ~10ms later and UPDATES the generation with token data.
 *
 * Hooks:
 *   - before_agent_start: capture prompt text and start time
 *   - agent_end: create trace + generation (without token data)
 *   - llm_output: update the generation with model, provider, and token usage
 */

export function register(api) {
  let publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  let secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  let baseUrl = process.env.LANGFUSE_BASE_URL?.trim();

  if (!publicKey || !secretKey) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const envPath = path.join(process.env.HOME || '', '.openclaw', 'secrets', 'langfuse-keys.env');
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const key = trimmed.slice(0, eq);
          const val = trimmed.slice(eq + 1);
          if (key === 'LANGFUSE_PUBLIC_KEY') publicKey = val;
          if (key === 'LANGFUSE_SECRET_KEY') secretKey = val;
        }
      }
    } catch {}
  }

  baseUrl = (baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');

  if (!publicKey || !secretKey) {
    api.logger.info('[langfuse-tracer] keys not set — tracing disabled');
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  api.logger.info(`[langfuse-tracer] v3 enabled → ${baseUrl}`);

  // ── Shared state ────────────────────────────────────────────────────────

  // Keyed by sessionKey. Stores prompt + start time from before_agent_start,
  // and the generationId created by agent_end (so llm_output can update it).
  const pendingTurns = new Map();

  // ── Helper: send batch to Langfuse ──────────────────────────────────────

  const sendBatch = async (batch) => {
    try {
      const res = await fetch(`${baseUrl}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        api.logger.warn(`[langfuse-tracer] Ingestion failed ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      api.logger.warn(`[langfuse-tracer] Fetch error: ${String(err)}`);
    }
  };

  // ── Hook: before_agent_start ────────────────────────────────────────────

  api.on('before_agent_start', (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? 'default';
    pendingTurns.set(key, {
      prompt: event.prompt ?? '',
      startedAt: Date.now(),
      generationId: null, // Will be set by agent_end
      traceId: null,      // Will be set by agent_end
    });
  });

  // ── Hook: agent_end ─────────────────────────────────────────────────────
  // Fires FIRST. Creates trace + generation WITHOUT token data.
  // Stores the generationId so llm_output can update it.

  api.on('agent_end', async (event, ctx) => {
    const { agentId, sessionKey } = ctx;
    const { messages, success, durationMs, error } = event;

    const key = sessionKey ?? agentId ?? 'default';
    const pending = pendingTurns.get(key);
    // Don't delete yet — llm_output needs the generationId

    const now = new Date().toISOString();
    const startedAt = pending?.startedAt ?? (durationMs ? Date.now() - durationMs : Date.now());
    const startTime = new Date(startedAt).toISOString();

    // Extract input
    let input = pending?.prompt ?? '';
    if (!input) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
          input = extractText(messages[i].content, 2000);
          break;
        }
      }
    }

    // Extract output (last assistant message)
    let output = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        output = extractText(messages[i].content, 4000);
        break;
      }
    }

    // Count tool calls
    let toolCallCount = 0;
    let assistantMsgCount = 0;
    for (const msg of messages) {
      if (msg?.role === 'assistant') assistantMsgCount++;
      if (msg?.role === 'tool' || msg?.role === 'toolResult') toolCallCount++;
    }

    const traceId = randomId();
    const generationId = randomId();

    // Store IDs so llm_output can update
    if (pending) {
      pending.generationId = generationId;
      pending.traceId = traceId;
    }

    // Schedule cleanup — if llm_output doesn't fire within 5s, clean up
    setTimeout(() => { pendingTurns.delete(key); }, 5000);

    const batch = [
      {
        id: randomId(),
        type: 'trace-create',
        timestamp: now,
        body: {
          id: traceId,
          name: 'openclaw-turn',
          sessionId: sessionKey ?? undefined,
          userId: agentId ?? 'unknown',
          tags: ['openclaw', agentId ?? 'unknown'],
          input: input.slice(0, 2000) || undefined,
          output: output.slice(0, 4000) || undefined,
          metadata: {
            success,
            error: error ?? undefined,
            messageCount: messages.length,
            toolCallCount,
            assistantMsgCount,
          },
          timestamp: startTime,
        },
      },
      {
        id: randomId(),
        type: 'generation-create',
        timestamp: now,
        body: {
          id: generationId,
          traceId,
          name: 'llm',
          startTime,
          endTime: now,
          input: input.slice(0, 2000) || undefined,
          output: output.slice(0, 4000) || undefined,
          level: success ? 'DEFAULT' : 'ERROR',
          statusMessage: error ?? undefined,
          // No usage or model yet — llm_output will update
          metadata: {
            durationMs,
            messageCount: messages.length,
            toolCallCount,
            assistantMsgCount,
            note: 'token data arrives via generation-update from llm_output hook',
          },
        },
      },
    ];

    await sendBatch(batch);
  });

  // ── Hook: llm_output ───────────────────────────────────────────────────
  // Fires ~10ms AFTER agent_end. Updates the generation with real data.

  api.on('llm_output', async (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.agentId ?? 'default';
    const pending = pendingTurns.get(key);

    if (!pending?.generationId) {
      // agent_end hasn't fired yet or already cleaned up — store data for later
      // This shouldn't happen given the observed ordering, but handle gracefully
      api.logger.info(`[langfuse-tracer] llm_output: no generationId yet for ${key}, skipping update`);
      return;
    }

    const usage = event.usage ? {
      input: typeof event.usage.input === 'number' ? event.usage.input : undefined,
      output: typeof event.usage.output === 'number' ? event.usage.output : undefined,
      total: typeof event.usage.total === 'number' ? event.usage.total : undefined,
      unit: 'TOKENS',
    } : undefined;

    const model = event.model ?? undefined;
    const provider = event.provider ?? undefined;

    // Update the generation with token data and model
    const batch = [
      {
        id: randomId(),
        type: 'generation-update',
        timestamp: new Date().toISOString(),
        body: {
          id: pending.generationId,
          traceId: pending.traceId,
          model,
          usage,
          metadata: {
            provider,
            model,
            tokenUpdateApplied: true,
          },
        },
      },
      // Also update the trace with model/provider tags
      {
        id: randomId(),
        type: 'trace-create',
        timestamp: new Date().toISOString(),
        body: {
          id: pending.traceId,
          metadata: {
            model,
            provider,
          },
          tags: ['openclaw', ctx.agentId ?? 'unknown', ...(provider ? [provider] : []), ...(model ? [model] : [])],
        },
      },
    ];

    await sendBatch(batch);

    // Clean up
    pendingTurns.delete(key);
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function extractText(content, maxLen) {
  if (typeof content === 'string') {
    return content.slice(0, maxLen);
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .slice(0, maxLen);
  }
  return '';
}

function randomId() {
  return crypto.randomUUID();
}
