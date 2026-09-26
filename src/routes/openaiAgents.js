import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  attachOpenAISessionId,
  createSessionWorkspace,
  executeWorkspaceBash,
  executeWorkspaceCommand,
  findWorkspaceBySession,
  writeWorkspaceFile,
} from '../control-plane/store.js';
import { openaiAgentsConfig, hasOpenAIKey } from '../openai-agents/config.js';
import { getOpenAIClient, pageToArray } from '../openai-agents/client.js';

const router = express.Router();

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''),
  );
}

function buildMetadata(input = {}) {
  const metadata = parseJson(input.metadata, {});
  const enriched = cleanObject({
    ...metadata,
    user_id: input.userId || metadata?.user_id,
    agent_id: input.agentId || metadata?.agent_id,
    agent_name: input.agentName || metadata?.agent_name,
    agent_model: input.agentModel || metadata?.agent_model,
    workspace_id: input.workspaceId || metadata?.workspace_id,
    workspace_path: input.workspacePath || metadata?.workspace_path,
    pod_name: input.podName || metadata?.pod_name,
    pvc_name: input.pvcName || metadata?.pvc_name,
  });

  return Object.keys(enriched).length
    ? Object.fromEntries(Object.entries(enriched).map(([key, value]) => [key, String(value)]))
    : undefined;
}

function buildAgent(input = {}, { requireModel = true } = {}) {
  const multiAgent =
    input.multiAgentEnabled || input.multi_agent?.enabled
      ? {
          enabled: true,
          max_concurrent_subagents: Number(input.maxConcurrentSubagents || 3),
        }
      : undefined;

  return cleanObject({
    name: input.name,
    model: input.model || (requireModel ? openaiAgentsConfig.defaultModel : undefined),
    instructions: input.instructions,
    metadata: parseJson(input.metadata, undefined),
    tools: parseJson(input.tools, undefined),
    multi_agent: input.multi_agent || multiAgent,
    service_tier: input.service_tier,
    reasoning: parseJson(input.reasoning, undefined),
    text: parseJson(input.text, undefined),
  });
}

function buildEnvironment(input = {}) {
  if (input.environment?.type) return input.environment;

  if (input.environmentType === 'openai_hosted') {
    return cleanObject({
      type: 'openai_hosted',
      capability_directories: parseJson(input.capabilityDirectories, undefined),
      network: parseJson(input.network, undefined),
      packages: parseJson(input.packages, undefined),
    });
  }

  if (input.environmentType === 'self_hosted') {
    return {
      type: 'self_hosted',
      workspace_directory: input.workspaceDirectory || '/workspace',
    };
  }

  return { type: 'none' };
}

function buildInput(input) {
  if (Array.isArray(input)) return input;

  return [
    {
      role: 'user',
      content: [{ type: 'input_text', text: input || '' }],
    },
  ];
}

function workspaceToolUnavailable(resolvedWorkspaceId) {
  if (resolvedWorkspaceId) return null;

  return {
    error: 'No session workspace is attached to this chat.',
  };
}

router.get('/status', (req, res) => {
  res.json({
    ok: hasOpenAIKey(),
    apiKeyConfigured: hasOpenAIKey(),
    defaultModel: openaiAgentsConfig.defaultModel,
    sdk: {
      betaAgents: true,
      resources: ['agents', 'sessions', 'events', 'items', 'turns', 'subagents', 'artifacts'],
    },
  });
});

router.get('/agents', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await pageToArray(client.beta.agents.list(req.query)));
  } catch (err) {
    next(err);
  }
});

router.post('/agents', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    const agent = await client.beta.agents.create(buildAgent(req.body, { requireModel: true }));
    res.status(201).json(agent);
  } catch (err) {
    next(err);
  }
});

router.get('/agents/:id', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await client.beta.agents.retrieve(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/agents/:id', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await client.beta.agents.update(req.params.id, buildAgent(req.body, { requireModel: false })));
  } catch (err) {
    next(err);
  }
});

router.delete('/agents/:id', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await client.beta.agents.delete(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await pageToArray(client.beta.agents.sessions.list(req.query)));
  } catch (err) {
    next(err);
  }
});

router.post('/sessions', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    const environment = buildEnvironment(req.body);
    const input = typeof req.body.input === 'string' ? req.body.input.trim() : req.body.input;

    if (environment.type === 'none' && !input) {
      return res.status(400).json({
        error: 'Initial input is required when creating a conversation-only session.',
        details: {
          message: 'Add an initial message or choose an OpenAI hosted workspace.',
        },
      });
    }

    const workspace =
      req.body.userId && req.body.agentId
        ? await createSessionWorkspace({
            userId: req.body.userId,
            sessionId: `pending-${randomUUID()}`,
            agentId: req.body.agentId,
            agentName: req.body.agentName,
          })
        : null;

    const body = cleanObject({
      agent_id: req.body.agentId,
      agent: req.body.agentId ? parseJson(req.body.agentOverrides, undefined) : buildAgent(req.body, { requireModel: true }),
      environment,
      input: input || undefined,
      metadata: buildMetadata({
        ...req.body,
        workspaceId: workspace?.id,
        workspacePath: workspace?.runtimePath,
        podName: workspace?.podName,
        pvcName: workspace?.pvcName,
      }),
      vault_ids: parseJson(req.body.vaultIds, undefined),
    });

    const session = await client.beta.agents.sessions.create(body);
    if (workspace) {
      await attachOpenAISessionId(workspace.id, session.id);
    }

    res.status(201).json({ ...session, workspace });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await client.beta.agents.sessions.retrieve(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:id', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await client.beta.agents.sessions.delete(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/input', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    await client.beta.agents.sessions.events.create(req.params.id, {
      events: [
        {
          type: 'agent.session.input.message',
          input: buildInput(req.body.input),
        },
      ],
      'Idempotency-Key': req.get('Idempotency-Key') || randomUUID(),
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/stream', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    const session = await client.beta.agents.sessions.retrieve(req.params.id);
    const workspaceId = session.metadata?.workspace_id;
    const workspace = workspaceId ? null : await findWorkspaceBySession(req.params.id);
    const resolvedWorkspaceId = workspaceId || workspace?.id;
    let toolCallCount = 0;

    const stream = client.beta.agents.sessions.stream(req.params.id, {
      input: req.body.input,
      idempotencyKey: req.get('Idempotency-Key') || randomUUID(),
      toolHandlers: {
        read_workspace_bash: async (args) => {
          toolCallCount += 1;
          if (toolCallCount > 8) {
            return {
              error: 'Tool call limit reached for this turn.',
              allowed_tool_calls: 8,
            };
          }

          const unavailable = workspaceToolUnavailable(resolvedWorkspaceId);
          if (unavailable) return unavailable;

          const result = await executeWorkspaceBash(
            resolvedWorkspaceId,
            args.command,
            args.cwd || '.',
          );

          if (!result) {
            return {
              error: 'Workspace not found.',
              workspace_id: resolvedWorkspaceId,
            };
          }

          return {
            command: result.command,
            cwd: result.cwd,
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
        write_workspace_file: async (args) => {
          toolCallCount += 1;
          if (toolCallCount > 8) {
            return {
              error: 'Tool call limit reached for this turn.',
              allowed_tool_calls: 8,
            };
          }

          const unavailable = workspaceToolUnavailable(resolvedWorkspaceId);
          if (unavailable) return unavailable;

          const result = await writeWorkspaceFile(
            resolvedWorkspaceId,
            args.path,
            args.content || '',
          );

          if (!result) {
            return {
              error: 'Workspace not found.',
              workspace_id: resolvedWorkspaceId,
            };
          }

          return {
            path: result.path,
            size_bytes: result.sizeBytes,
            updated_at: result.updatedAt,
          };
        },
        run_workspace_command: async (args) => {
          toolCallCount += 1;
          if (toolCallCount > 8) {
            return {
              error: 'Tool call limit reached for this turn.',
              allowed_tool_calls: 8,
            };
          }

          const unavailable = workspaceToolUnavailable(resolvedWorkspaceId);
          if (unavailable) return unavailable;

          const result = await executeWorkspaceCommand(
            resolvedWorkspaceId,
            args.command,
            args.cwd || '.',
          );

          if (!result) {
            return {
              error: 'Workspace not found.',
              workspace_id: resolvedWorkspaceId,
            };
          }

          return {
            command: result.command,
            cwd: result.cwd,
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
      },
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id/events', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    const stream = await client.beta.agents.sessions.events.stream(req.params.id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id/items', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await pageToArray(client.beta.agents.sessions.items.list(req.params.id, req.query)));
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id/turns', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(await pageToArray(client.beta.agents.sessions.turns.list(req.params.id, req.query)));
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:sessionId/turns/:turnId', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    res.json(
      await client.beta.agents.sessions.turns.retrieve(req.params.turnId, {
        session_id: req.params.sessionId,
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/events', async (req, res, next) => {
  try {
    const client = getOpenAIClient();
    await client.beta.agents.sessions.events.create(req.params.id, {
      events: req.body.events,
      'Idempotency-Key': req.get('Idempotency-Key') || randomUUID(),
    });
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
