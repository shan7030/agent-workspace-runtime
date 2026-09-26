import express from 'express';
import {
  createSessionWorkspace,
  ensureUserRuntime,
  executeWorkspaceBash,
  getUserRuntime,
  listUsers,
  listWorkspaceFiles,
  listWorkspaces,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '../control-plane/store.js';

const router = express.Router();

router.get('/users', async (req, res, next) => {
  try {
    res.json({ data: await listUsers() });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:userId/runtime', async (req, res, next) => {
  try {
    res.status(201).json(await ensureUserRuntime(req.params.userId, req.body));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:userId/runtime', async (req, res, next) => {
  try {
    const runtime = await getUserRuntime(req.params.userId);
    if (!runtime.user) {
      return res.status(404).json({ error: 'Runtime not found for user.' });
    }

    res.json(runtime);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:userId/workspaces', async (req, res, next) => {
  try {
    res.json({ data: await listWorkspaces(req.params.userId) });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:userId/workspaces', async (req, res, next) => {
  try {
    const workspace = await createSessionWorkspace({
      userId: req.params.userId,
      sessionId: req.body.sessionId || `local-session-${Date.now()}`,
      agentId: req.body.agentId,
      agentName: req.body.agentName,
    });

    res.status(201).json(workspace);
  } catch (err) {
    next(err);
  }
});

router.get('/workspaces/:workspaceId/files', async (req, res, next) => {
  try {
    const result = await listWorkspaceFiles(req.params.workspaceId, req.query.path || '.');
    if (!result) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/workspaces/:workspaceId/files/content', async (req, res, next) => {
  try {
    if (!req.query.path) {
      return res.status(400).json({ error: 'File path is required.' });
    }

    const result = await readWorkspaceFile(req.params.workspaceId, req.query.path);
    if (!result) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/workspaces/:workspaceId/files', async (req, res, next) => {
  try {
    if (!req.body.path) {
      return res.status(400).json({ error: 'File path is required.' });
    }

    const result = await writeWorkspaceFile(req.params.workspaceId, req.body.path, req.body.content || '');
    if (!result) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/workspaces/:workspaceId/bash', async (req, res, next) => {
  try {
    if (!req.body.command) {
      return res.status(400).json({ error: 'Command is required.' });
    }

    const result = await executeWorkspaceBash(req.params.workspaceId, req.body.command, req.body.cwd || '.');
    if (!result) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
