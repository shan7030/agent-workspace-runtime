# OpenAI Agents API Backend

This project now includes a separate Express backend and React UI for experimenting with the OpenAI Agents API.

The implementation uses the official OpenAI Node SDK:

```js
client.beta.agents
client.beta.agents.sessions
client.beta.agents.sessions.events
client.beta.agents.sessions.items
client.beta.agents.sessions.turns
```

The SDK sends Agents API requests with the beta header:

```text
OpenAI-Beta: agents=v1
```

## Configure

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY="your_api_key_here"
```

Optional default model override:

```bash
OPENAI_AGENTS_MODEL="gpt-5.6-luna"
```

The root `.env` file is already ignored by Git.

Optional runtime settings:

```bash
RUNTIME_PROVIDER="local" # or "kubernetes"
RUNTIME_IMAGE="agent-runtime:local"
K8S_NAMESPACE="agent-lab"
K8S_STORAGE_SIZE="1Gi"
# K8S_STORAGE_CLASS="standard"
```

## Start The Backend

```bash
npm run start:agents
```

The backend runs on:

```text
http://localhost:3200
```

## Start The UI

```bash
cd client
/Users/shantanujoshi/.nvm/versions/node/v24.18.0/bin/node ./node_modules/vite/bin/vite.js --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/
```

The Vite dev server proxies `/api` to the Agents backend.

## Architecture

The system is split across four responsibilities:

```text
UI:                 agent builder, chat UI, runtime/workspace browser
Backend:            your product control plane
OpenAI Agents API:  agent/session/turn execution loop
Kubernetes runtime: per-user pods, PVC-backed workspaces, skills, artifacts, and tools
```

### Multi-User Architecture

```mermaid
flowchart TB
  subgraph clients["Clients"]
    u1["User A Browser\nReact UI"]
    u2["User B Browser\nReact UI"]
  end

  subgraph backend["Express Backend: Agent Lab Control Plane"]
    api["HTTP API\n/api + /api/control-plane"]
    agentRoutes["Agent Routes\ncreate/list/update agents"]
    sessionRoutes["Session Routes\ncreate chats, stream turns"]
    runtimeRoutes["Runtime Routes\nusers, pods, PVCs, workspaces, files"]
    metadata["Local Metadata Store\ndata/control-plane.json"]
  end

  subgraph openai["OpenAI Cloud: Agents API"]
    agentsCloud["Agents\nmodel + instructions + tools"]
    sessionsCloud["Sessions\nconversation state"]
    turnsCloud["Turns\none execution per user message"]
    itemsCloud["Items\nmessages, reasoning summaries, tool records"]
    eventsCloud["Events\nstreaming timeline"]
  end

  subgraph cluster["Kubernetes Cluster"]
    ns["Namespace\nagent-lab"]

    subgraph userA["User A Runtime"]
      podA["Pod\nagent-runtime-user-a"]
      containerA["Container\nagent-runtime:local\nbash, ls, cat, grep, node"]
      pvcA["PVC\nagent-workspace-user-a"]
      wsA1["Workspace\n/workspace/users/user-a/sessions/ws-001"]
      wsA2["Workspace\n/workspace/users/user-a/sessions/ws-002"]
    end

    subgraph userB["User B Runtime"]
      podB["Pod\nagent-runtime-user-b"]
      containerB["Container\nagent-runtime:local\nbash, ls, cat, grep, node"]
      pvcB["PVC\nagent-workspace-user-b"]
      wsB1["Workspace\n/workspace/users/user-b/sessions/ws-101"]
    end
  end

  u1 --> api
  u2 --> api

  api --> agentRoutes
  api --> sessionRoutes
  api --> runtimeRoutes
  runtimeRoutes --> metadata

  agentRoutes --> agentsCloud
  sessionRoutes --> sessionsCloud
  sessionsCloud --> turnsCloud
  sessionsCloud --> itemsCloud
  turnsCloud --> eventsCloud
  eventsCloud -.server-sent events.-> sessionRoutes
  sessionRoutes -.stream response.-> u1
  sessionRoutes -.stream response.-> u2

  runtimeRoutes --> ns
  ns --> podA
  ns --> podB
  podA --> containerA
  podB --> containerB
  containerA --> pvcA
  containerB --> pvcB
  pvcA --> wsA1
  pvcA --> wsA2
  pvcB --> wsB1

  sessionsCloud -.metadata: user_id, agent_id, workspace_id, pod_name, pvc_name.-> metadata
  sessionRoutes -.tool call: read_workspace_bash.-> runtimeRoutes
  runtimeRoutes -.kubectl exec / kubectl cp.-> podA
  runtimeRoutes -.kubectl exec / kubectl cp.-> podB
```

### Storage Map

| Data | Stored Where | Why |
| --- | --- | --- |
| Agent definitions | OpenAI Agents API | OpenAI needs the model, instructions, tools, and reasoning config to run the agent loop. |
| Chat/session history | OpenAI Agents API sessions | OpenAI stores the durable conversation state, turns, items, and streamable events. |
| Runtime metadata | `data/control-plane.json` | The backend needs a local map from users/sessions to pods, PVCs, and workspace paths. |
| Workspace files in local mode | `data/workspaces/<user>/sessions/<workspace-id>/` | Useful for development without Kubernetes. |
| Workspace files in Kubernetes mode | PVC mounted into the pod at `/workspace` | Files survive container restarts and stay isolated per user runtime. |
| Skills | `<workspace>/skills/` | Uploaded or generated capabilities available to that session. |
| Artifacts | `<workspace>/artifacts/` | Files produced by tools or agent work during a session. |

### Per-User Runtime Shape

```text
Kubernetes namespace: agent-lab

User A
  Pod: agent-runtime-user-a
  PVC: agent-workspace-user-a
  Mount path inside container: /workspace
  Session workspaces:
    /workspace/users/user-a/sessions/ws-001/
      files/
      skills/
      artifacts/
    /workspace/users/user-a/sessions/ws-002/
      files/
      skills/
      artifacts/

User B
  Pod: agent-runtime-user-b
  PVC: agent-workspace-user-b
  Mount path inside container: /workspace
  Session workspaces:
    /workspace/users/user-b/sessions/ws-101/
      files/
      skills/
      artifacts/
```

### Entity Relationships

```mermaid
erDiagram
  USER ||--|| RUNTIME : owns
  USER ||--o{ AGENT : creates
  USER ||--o{ SESSION : starts
  AGENT ||--o{ SESSION : linked_to
  SESSION ||--|| WORKSPACE : has
  RUNTIME ||--o{ WORKSPACE : mounts
  SESSION ||--o{ TURN : executes
  SESSION ||--o{ ITEM : stores
  TURN ||--o{ EVENT : emits
  WORKSPACE ||--o{ WORKSPACE_FILE : contains

  USER {
    string id
    string displayName
  }

  RUNTIME {
    string id
    string provider
    string podName
    string pvcName
    string namespace
  }

  AGENT {
    string id
    string model
    string instructions
    json tools
  }

  SESSION {
    string id
    string agentId
    string userId
    string workspaceId
  }

  WORKSPACE {
    string id
    string hostPath
    string runtimePath
    string status
  }

  TURN {
    string id
    string status
  }

  ITEM {
    string id
    string type
    string role
  }

  EVENT {
    string type
    string delta
  }
```

### New Chat Flow

```mermaid
sequenceDiagram
  participant UI as React UI
  participant BE as Express Backend
  participant CP as Control Plane Store
  participant OA as OpenAI Agents API
  participant RT as User Runtime / PVC

  UI->>BE: POST /api/sessions\nuserId, agentId, initial input
  BE->>CP: ensureUserRuntime(userId)
  CP-->>BE: podName, pvcName, runtime root
  BE->>RT: reserve session workspace
  RT-->>BE: workspaceId + runtimePath
  BE->>OA: create session\nagent_id + input + metadata
  OA-->>BE: session id
  BE->>CP: attach OpenAI session id to workspace
  BE-->>UI: session + workspace metadata
  UI->>BE: GET items/turns
  BE->>OA: list session items/turns
  OA-->>BE: transcript/run state
  BE-->>UI: render chat + workspace details
```

### Message / Run Flow

```mermaid
sequenceDiagram
  participant UI as React UI
  participant BE as Express Backend
  participant OA as OpenAI Agents API
  participant RT as User Runtime / Workspace

  UI->>BE: POST /api/sessions/:id/stream\nuser message
  BE->>OA: stream session turn
  OA-->>BE: event: turn started
  BE-->>UI: SSE event
  OA-->>BE: event: output text delta
  BE-->>UI: SSE delta
  OA-->>BE: event: tool call requested
  BE->>RT: execute tool against session workspace
  RT-->>BE: tool result / file artifact
  BE->>OA: tool result event
  OA-->>BE: final assistant output
  BE-->>UI: final events
  UI->>BE: GET items/turns
  BE->>OA: fetch durable state
```

### Items, Turns, And Events

```text
Items
  Durable session objects: user messages, assistant messages, tool calls,
  tool results, files, and artifacts. Use these to rebuild the chat state.

Turns
  One execution cycle from input to completion. Use these for run history,
  eval records, status, timing, cost, failures, and retries.

Events
  Live timeline emitted while a turn is running. Use these for streaming UI,
  tool progress, approval prompts, and debugging.
```

### Local MVP Versus Kubernetes

The backend supports two runtime providers:

```text
RUNTIME_PROVIDER=local
  stores workspace files on the backend filesystem

RUNTIME_PROVIDER=kubernetes
  creates or reuses a Namespace, PVC, and user runtime Pod with kubectl
  executes workspace reads and bash commands inside that Pod
```

The local provider stores files here:

```text
data/workspaces/<user>/sessions/<workspace-id>/
```

That path represents the PVC-mounted workspace that a real runtime pod would see as:

```text
/workspace/users/<user>/sessions/<workspace-id>/
```

The Kubernetes provider implements the same operations:

```text
ensureUserRuntime(userId)
  kubectl apply Namespace
  kubectl apply PersistentVolumeClaim
  kubectl apply runtime Pod
  kubectl wait for Pod readiness

createSessionWorkspace(userId, sessionId, agentId)
  kubectl exec mkdir -p files/ skills/ artifacts/ inside the PVC
  return runtimePath for session metadata

writeWorkspaceFile(workspaceId, path, content)
  kubectl cp files, skills, configs, and artifacts into the PVC

executeWorkspaceBash(workspaceId, command, cwd)
  kubectl exec a constrained read-only shell command inside the session workspace
```

Build the runtime container:

```bash
npm run build:runtime
```

For Docker Desktop Kubernetes, the `agent-runtime:local` image is usually visible to the cluster after building locally. For Minikube, build inside Minikube's Docker environment or load the image:

```bash
minikube image load agent-runtime:local
```

Then set:

```bash
RUNTIME_PROVIDER="kubernetes"
```

## Routes

```text
GET    /api/status

GET    /api/agents
POST   /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id
DELETE /api/agents/:id

GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
DELETE /api/sessions/:id

POST   /api/sessions/:id/input
POST   /api/sessions/:id/stream
GET    /api/sessions/:id/events
POST   /api/sessions/:id/events

GET    /api/sessions/:id/items
GET    /api/sessions/:id/turns
GET    /api/sessions/:sessionId/turns/:turnId

GET    /api/control-plane/users
POST   /api/control-plane/users/:userId/runtime
GET    /api/control-plane/users/:userId/runtime
GET    /api/control-plane/users/:userId/workspaces
POST   /api/control-plane/users/:userId/workspaces

GET    /api/control-plane/workspaces/:workspaceId/files
PUT    /api/control-plane/workspaces/:workspaceId/files
GET    /api/control-plane/workspaces/:workspaceId/files/content
POST   /api/control-plane/workspaces/:workspaceId/bash
```

## Control Plane Model

The backend now has a local control-plane layer that mirrors the Kubernetes architecture:

```text
user
  runtime: one pod + one PVC
  workspaces: one session workspace per chat
    files/
    skills/
    artifacts/
```

For local development this is persisted in:

```text
data/control-plane.json
data/workspaces/<user>/sessions/<workspace-id>/
```

In a real cluster, the same records map cleanly to:

```text
podName: agent-runtime-<user>
pvcName: agent-workspace-<user>
runtimePath: /workspace/users/<user>/sessions/<workspace-id>
```

When the UI creates an Agents API session, it sends `userId` and `agentId`. The backend ensures the user's runtime exists, creates a per-session workspace, and stores the workspace/pod/PVC metadata on the OpenAI session.

## Notes

Use `environmentType: "none"` for simple chat/session tests.

Use `environmentType: "openai_hosted"` when you want the managed sandbox behavior described in the Agents API docs.
