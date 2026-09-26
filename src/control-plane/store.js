import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const dataDir = path.resolve(process.cwd(), 'data');
const statePath = path.join(dataDir, 'control-plane.json');
const workspaceRoot = path.join(dataDir, 'workspaces');
const uploadScratchRoot = path.join(dataDir, 'uploads');
const execFileAsync = promisify(execFile);
const readOnlyCommands = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'sed', 'find', 'wc', 'grep', 'du', 'stat', 'file']);
const executableCommands = new Set(['node', 'python', 'python3']);

const emptyState = {
  users: {},
  runtimes: {},
  workspaces: {},
};

async function ensureBaseDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(uploadScratchRoot, { recursive: true });
}

async function readState() {
  await ensureBaseDirs();

  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return { ...emptyState, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { ...emptyState };
  }
}

async function writeState(state) {
  await ensureBaseDirs();
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function now() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'default';
}

function workspaceDirFor(userId, workspaceId) {
  return path.join(workspaceRoot, slug(userId), 'sessions', slug(workspaceId));
}

function runtimeProvider() {
  return process.env.RUNTIME_PROVIDER || 'local';
}

function runtimeImage() {
  return process.env.RUNTIME_IMAGE || 'agent-runtime:local';
}

function storageClassName() {
  return process.env.K8S_STORAGE_CLASS || undefined;
}

function storageSize() {
  return process.env.K8S_STORAGE_SIZE || '1Gi';
}

function isKubernetesRuntime(runtime) {
  return runtime.provider === 'kubernetes';
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function safeRelativeWorkspacePath(requestedPath, { allowCurrent = false } = {}) {
  const rawPath = String(requestedPath || '').trim();

  if (!rawPath || rawPath === '.') {
    if (allowCurrent) return '.';
    const err = new Error('Workspace path is required.');
    err.status = 400;
    throw err;
  }

  if (path.posix.isAbsolute(rawPath) || rawPath.split('/').includes('..')) {
    const err = new Error('Workspace paths must be relative and cannot contain "..".');
    err.status = 400;
    throw err;
  }

  return path.posix.normalize(rawPath);
}

function validateWorkspaceCommand(command, allowedCommands, label) {
  const trimmed = String(command || '').trim();
  const commandName = trimmed.split(/\s+/)[0];

  if (!allowedCommands.has(commandName)) {
    const err = new Error(`Command "${commandName || 'empty'}" is not allowed for ${label}.`);
    err.status = 400;
    throw err;
  }

  if (/[;&|`$()<>]/.test(trimmed) || /(^|\s)\//.test(trimmed) || trimmed.includes('..')) {
    const err = new Error('Only simple commands with relative workspace paths are allowed.');
    err.status = 400;
    throw err;
  }

  return trimmed;
}

function kubectl(args, options = {}) {
  return execFileAsync('kubectl', args, {
    timeout: options.timeout || 15000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    env: process.env,
  });
}

function kubectlApply(manifest) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(stderr || stdout || `kubectl apply exited with ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    child.stdin.write(manifest);
    child.stdin.end();
  });
}

function runtimeManifest(runtime) {
  const storageClass = storageClassName();
  const storageClassBlock = storageClass ? `  storageClassName: ${storageClass}\n` : '';

  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: ${runtime.namespace}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${runtime.pvcName}
  namespace: ${runtime.namespace}
  labels:
    app.kubernetes.io/name: agent-runtime
    agent-lab/user-id: ${runtime.userId}
spec:
  accessModes:
    - ReadWriteOnce
${storageClassBlock}  resources:
    requests:
      storage: ${storageSize()}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${runtime.podName}
  namespace: ${runtime.namespace}
  labels:
    app.kubernetes.io/name: agent-runtime
    agent-lab/user-id: ${runtime.userId}
spec:
  restartPolicy: Always
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
    - name: runtime
      image: ${runtimeImage()}
      imagePullPolicy: IfNotPresent
      command: ["/bin/bash", "-lc", "mkdir -p /workspace/users/${runtime.userId}/sessions && sleep infinity"]
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 512Mi
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: ${runtime.pvcName}
`;
}

async function ensureKubernetesRuntime(runtime) {
  await kubectlApply(runtimeManifest(runtime));
  await kubectl(['-n', runtime.namespace, 'wait', '--for=condition=Ready', `pod/${runtime.podName}`, '--timeout=120s'], {
    timeout: 130000,
  });
}

async function kubernetesExec(runtime, command, options = {}) {
  return kubectl(
    ['-n', runtime.namespace, 'exec', runtime.podName, '--', '/bin/bash', '-lc', command],
    {
      timeout: options.timeout || 10000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
    },
  );
}

export async function listUsers() {
  const state = await readState();
  return Object.values(state.users);
}

export async function ensureUserRuntime(userId, options = {}) {
  const normalizedUserId = slug(userId);
  const state = await readState();
  const existingUser = state.users[normalizedUserId];
  const createdAt = existingUser?.createdAt || now();

  const user = {
    id: normalizedUserId,
    displayName: options.displayName || existingUser?.displayName || normalizedUserId,
    createdAt,
    updatedAt: now(),
  };

  const runtime =
    state.runtimes[normalizedUserId] || {
      id: `rt_${randomUUID()}`,
      userId: normalizedUserId,
      provider: runtimeProvider(),
      podName: `agent-runtime-${normalizedUserId}`,
      pvcName: `agent-workspace-${normalizedUserId}`,
      namespace: process.env.K8S_NAMESPACE || 'agent-lab',
      image: runtimeImage(),
      status: 'provisioning',
      workspaceRoot: `/workspace/users/${normalizedUserId}`,
      createdAt: now(),
    };

  if (runtime.provider !== runtimeProvider()) {
    runtime.provider = runtimeProvider();
    runtime.status = 'provisioning';
  }

  runtime.image = runtime.image || runtimeImage();

  if (isKubernetesRuntime(runtime)) {
    await ensureKubernetesRuntime(runtime);
  }

  runtime.status = 'ready';
  runtime.updatedAt = now();
  state.users[normalizedUserId] = user;
  state.runtimes[normalizedUserId] = runtime;
  await writeState(state);

  return { user, runtime };
}

export async function getUserRuntime(userId) {
  const normalizedUserId = slug(userId);
  const state = await readState();
  return {
    user: state.users[normalizedUserId] || null,
    runtime: state.runtimes[normalizedUserId] || null,
    workspaces: Object.values(state.workspaces).filter((workspace) => workspace.userId === normalizedUserId),
  };
}

export async function createSessionWorkspace({ userId, sessionId, agentId, agentName }) {
  const normalizedUserId = slug(userId);
  await ensureUserRuntime(normalizedUserId);

  const state = await readState();
  const id = `ws_${randomUUID()}`;
  const runtimePath = `/workspace/users/${normalizedUserId}/sessions/${id}`;
  const runtime = state.runtimes[normalizedUserId];
  const hostPath = isKubernetesRuntime(runtime) ? '' : workspaceDirFor(normalizedUserId, id);

  if (isKubernetesRuntime(runtime)) {
    await kubernetesExec(runtime, `mkdir -p ${shSingleQuote(`${runtimePath}/files`)} ${shSingleQuote(`${runtimePath}/skills`)} ${shSingleQuote(`${runtimePath}/artifacts`)}`);
  } else {
    await fs.mkdir(path.join(hostPath, 'files'), { recursive: true });
    await fs.mkdir(path.join(hostPath, 'skills'), { recursive: true });
    await fs.mkdir(path.join(hostPath, 'artifacts'), { recursive: true });
  }

  const workspace = {
    id,
    userId: normalizedUserId,
    sessionId,
    agentId: agentId || '',
    agentName: agentName || '',
    runtimeId: state.runtimes[normalizedUserId]?.id || '',
    podName: state.runtimes[normalizedUserId]?.podName || '',
    pvcName: state.runtimes[normalizedUserId]?.pvcName || '',
    hostPath,
    runtimePath,
    status: 'ready',
    createdAt: now(),
    updatedAt: now(),
  };

  state.workspaces[id] = workspace;
  await writeState(state);
  return workspace;
}

export async function attachOpenAISessionId(workspaceId, sessionId) {
  const state = await readState();
  if (!state.workspaces[workspaceId]) return null;

  state.workspaces[workspaceId].sessionId = sessionId;
  state.workspaces[workspaceId].updatedAt = now();
  await writeState(state);
  return state.workspaces[workspaceId];
}

export async function getWorkspace(workspaceId) {
  const state = await readState();
  return state.workspaces[workspaceId] || null;
}

export async function findWorkspaceBySession(sessionId) {
  const state = await readState();
  return Object.values(state.workspaces).find((workspace) => workspace.sessionId === sessionId) || null;
}

export async function listWorkspaces(userId) {
  const normalizedUserId = slug(userId);
  const state = await readState();
  return Object.values(state.workspaces).filter((workspace) => workspace.userId === normalizedUserId);
}

export function safeWorkspacePath(workspace, requestedPath = '.') {
  const relativePath = String(requestedPath || '.').replace(/^\/+/, '');
  const resolved = path.resolve(workspace.hostPath, relativePath);
  const root = path.resolve(workspace.hostPath);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const err = new Error('Path escapes the session workspace.');
    err.status = 400;
    throw err;
  }

  return resolved;
}

export async function listWorkspaceFiles(workspaceId, requestedPath = '.') {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  if (!workspace.hostPath) {
    const runtime = (await getUserRuntime(workspace.userId)).runtime;
    const target = `${workspace.runtimePath}/${String(requestedPath || '.').replace(/^\/+/, '')}`;
    const { stdout } = await kubernetesExec(
      runtime,
      `find ${shSingleQuote(target)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n' | sort`,
    );

    return {
      workspace,
      path: requestedPath,
      files: stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, type] = line.split('\t');
          return {
            name,
            path: path.posix.join(String(requestedPath || '.').replace(/^\.$/, ''), name),
            type: type === 'd' ? 'directory' : 'file',
          };
        }),
    };
  }

  const dir = safeWorkspacePath(workspace, requestedPath);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  return {
    workspace,
    path: requestedPath,
    files: entries.map((entry) => ({
      name: entry.name,
      path: path.posix.join(String(requestedPath || '.').replace(/^\.$/, ''), entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
    })),
  };
}

export async function writeWorkspaceFile(workspaceId, requestedPath, content = '') {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const relativePath = safeRelativeWorkspacePath(requestedPath);

  if (!workspace.hostPath) {
    const runtime = (await getUserRuntime(workspace.userId)).runtime;
    const scratchPath = path.join(uploadScratchRoot, `${workspaceId}-${Date.now()}-${path.basename(relativePath)}`);
    const destination = `${workspace.runtimePath}/${relativePath}`;

    await fs.writeFile(scratchPath, content);
    await kubernetesExec(runtime, `mkdir -p ${shSingleQuote(path.posix.dirname(destination))}`);
    await kubectl(['-n', runtime.namespace, 'cp', scratchPath, `${runtime.podName}:${destination}`], { timeout: 30000 });
    await fs.rm(scratchPath, { force: true });

    return {
      workspace,
      path: relativePath,
      sizeBytes: Buffer.byteLength(content),
      updatedAt: now(),
    };
  }

  const destination = safeWorkspacePath(workspace, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);

  return {
    workspace,
    path: relativePath,
    sizeBytes: Buffer.byteLength(content),
    updatedAt: now(),
  };
}

export async function readWorkspaceFile(workspaceId, requestedPath) {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  if (!workspace.hostPath) {
    const runtime = (await getUserRuntime(workspace.userId)).runtime;
    const source = `${workspace.runtimePath}/${String(requestedPath || '').replace(/^\/+/, '')}`;
    const { stdout } = await kubernetesExec(runtime, `cat ${shSingleQuote(source)}`);

    return {
      workspace,
      path: requestedPath,
      content: stdout,
    };
  }

  const source = safeWorkspacePath(workspace, requestedPath);
  return {
    workspace,
    path: requestedPath,
    content: await fs.readFile(source, 'utf8'),
  };
}

export async function executeWorkspaceBash(workspaceId, command, requestedPath = '.') {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const trimmed = validateWorkspaceCommand(command, readOnlyCommands, 'the read-only workspace shell');
  const relativeCwd = safeRelativeWorkspacePath(requestedPath, { allowCurrent: true });

  if (!workspace.hostPath) {
    const runtime = (await getUserRuntime(workspace.userId)).runtime;
    const runtimeCwd = `${workspace.runtimePath}/${relativeCwd === '.' ? '' : relativeCwd}`;

    try {
      const result = await kubernetesExec(runtime, `cd ${shSingleQuote(runtimeCwd)} && ${trimmed}`, {
        timeout: 10000,
      });

      return {
        workspace,
        command: trimmed,
        cwd: relativeCwd,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err) {
      return {
        workspace,
        command: trimmed,
        cwd: relativeCwd,
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
      };
    }
  }

  const cwd = safeWorkspacePath(workspace, relativeCwd);

  try {
    const result = await execFileAsync('/bin/bash', ['-lc', trimmed], {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });

    return {
      workspace,
      command: trimmed,
      cwd: relativeCwd,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      workspace,
      command: trimmed,
      cwd: relativeCwd,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
    };
  }
}

export async function executeWorkspaceCommand(workspaceId, command, requestedPath = '.') {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const trimmed = validateWorkspaceCommand(command, executableCommands, 'workspace command execution');
  const relativeCwd = safeRelativeWorkspacePath(requestedPath, { allowCurrent: true });

  if (!workspace.hostPath) {
    const runtime = (await getUserRuntime(workspace.userId)).runtime;
    const runtimeCwd = `${workspace.runtimePath}/${relativeCwd === '.' ? '' : relativeCwd}`;

    try {
      const result = await kubernetesExec(runtime, `cd ${shSingleQuote(runtimeCwd)} && ${trimmed}`, {
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });

      return {
        workspace,
        command: trimmed,
        cwd: relativeCwd,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err) {
      return {
        workspace,
        command: trimmed,
        cwd: relativeCwd,
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
      };
    }
  }

  const cwd = safeWorkspacePath(workspace, relativeCwd);

  try {
    const result = await execFileAsync('/bin/bash', ['-lc', trimmed], {
      cwd,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });

    return {
      workspace,
      command: trimmed,
      cwd: relativeCwd,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      workspace,
      command: trimmed,
      cwd: relativeCwd,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
    };
  }
}
