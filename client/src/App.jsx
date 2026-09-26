import { useEffect, useMemo, useState } from 'react'
import './App.css'

const defaultModel = 'gpt-5.6-luna'

const defaultWorkspaceTools = [
  {
    type: 'function',
    name: 'read_workspace_bash',
    description: 'Run a safe read-only shell command inside the current session workspace. Use this to inspect files, list directories, and read workspace content.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        cwd: {
          type: 'string',
          default: '.',
          description: 'Relative working directory inside the session workspace.',
        },
        command: {
          type: 'string',
          description: 'Read-only command to run. Allowed examples: pwd, ls, cat files/notes.md, find skills, grep TODO files/notes.md, sed -n \'1,80p\' files/notes.md.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'write_workspace_file',
    description: 'Create or replace a text file inside the current session workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path inside the session workspace, for example files/tree.py or artifacts/result.txt.',
        },
        content: {
          type: 'string',
          description: 'Full text content to write to the file.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'run_workspace_command',
    description: 'Run an allowed executable command inside the current session workspace. Use this after writing code files that need execution.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        cwd: {
          type: 'string',
          default: '.',
          description: 'Relative working directory inside the session workspace.',
        },
        command: {
          type: 'string',
          description: 'Command to run. Allowed commands are node, python3, and python with relative file paths, for example python3 files/tree.py or node files/script.js.',
        },
      },
    },
  },
]

const emptyAgent = {
  name: 'Research helper',
  model: defaultModel,
  instructions: 'You are a concise workspace agent. Use read_workspace_bash for read-only inspection, write_workspace_file to create or update files, and run_workspace_command to execute allowed Node.js or Python files in the current session workspace. Keep commands simple and use only relative workspace paths.',
  reasoning: '{ "effort": "low", "summary": "auto" }',
  tools: JSON.stringify(defaultWorkspaceTools, null, 2),
  multiAgentEnabled: false,
  maxConcurrentSubagents: 3,
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  })

  const contentType = response.headers.get('content-type') || ''
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    throw new Error(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }

  return body
}

function rows(page) {
  return Array.isArray(page) ? page : page?.data || []
}

function eventText(events) {
  return events
    .filter((event) => event.type?.includes('output_text') && event.delta)
    .map((event) => event.delta)
    .join('')
}

function reasoningEventText(events) {
  return events
    .filter((event) => event.type?.includes('reasoning_summary_text') && event.delta)
    .map((event) => event.delta)
    .join('')
}

function itemText(item) {
  const content = item.content || item.output || []
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => part.text || part.output_text || '')
    .filter(Boolean)
    .join('\n')
}

function reasoningItemText(item) {
  if (item.type !== 'reasoning' || !Array.isArray(item.summary)) return ''

  return item.summary
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n')
}

function readableTime(value) {
  if (!value) return ''
  return new Date(value * 1000).toLocaleString()
}

function sessionAgentId(session) {
  return session?.agent_id || session?.agent?.id || session?.metadata?.agent_id || ''
}

function sessionWorkspaceId(session) {
  return session?.workspace?.id || session?.metadata?.workspace_id || ''
}

function formatTools(tools) {
  if (!tools || (Array.isArray(tools) && tools.length === 0)) return 'No tools configured.'
  if (typeof tools === 'string') return tools
  return JSON.stringify(tools, null, 2)
}

function compactJson(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function activityLabel(event) {
  const type = event.type || 'event'

  if (type.includes('function_call')) {
    return {
      title: `Tool call${event.name ? `: ${event.name}` : ''}`,
      detail: compactJson(event.arguments || event.delta || event),
    }
  }

  if (type.includes('reasoning_summary')) {
    return {
      title: 'Thinking summary',
      detail: event.delta || event.text || event.part?.text || compactJson(event),
    }
  }

  if (type.includes('tool') || type.includes('function_call_output')) {
    return {
      title: 'Tool result',
      detail: compactJson(event.output || event.result || event),
    }
  }

  if (type.includes('output_text') && event.delta) {
    return {
      title: 'Assistant text',
      detail: event.delta,
    }
  }

  if (type.includes('turn')) {
    return {
      title: type.replaceAll('.', ' '),
      detail: compactJson(event.status || event.error || event),
    }
  }

  if (type.includes('session')) {
    return {
      title: type.replaceAll('.', ' '),
      detail: compactJson(event.status || event.error || event),
    }
  }

  return {
    title: type.replaceAll('.', ' '),
    detail: compactJson(event.delta || event.message || event.error || event),
  }
}

function App() {
  const [status, setStatus] = useState({ ok: false, defaultModel })
  const [activeSideTab, setActiveSideTab] = useState('agents')
  const [activeInspectorTab, setActiveInspectorTab] = useState('activity')
  const [agents, setAgents] = useState([])
  const [sessions, setSessions] = useState([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedSession, setSelectedSession] = useState(null)
  const [items, setItems] = useState([])
  const [turns, setTurns] = useState([])
  const [events, setEvents] = useState([])
  const [userId, setUserId] = useState('demo-user')
  const [runtime, setRuntime] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [workspaceFiles, setWorkspaceFiles] = useState([])
  const [fileDraft, setFileDraft] = useState({
    path: 'files/notes.md',
    content: '# Notes\n\nAdd session context here.',
  })
  const [bashDraft, setBashDraft] = useState({
    cwd: '.',
    command: 'ls',
  })
  const [bashResult, setBashResult] = useState(null)
  const [agentDraft, setAgentDraft] = useState(emptyAgent)
  const [sessionDraft, setSessionDraft] = useState({
    environmentType: 'none',
    initialInput: 'Hello. Give me a two sentence summary of what you can do.',
  })
  const [prompt, setPrompt] = useState('Hello. Give me a two sentence summary of what you can do.')
  const [liveText, setLiveText] = useState('')
  const [liveReasoning, setLiveReasoning] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  )

  const selectedSessionAgent = useMemo(() => {
    const linkedAgentId = sessionAgentId(selectedSession)
    return agents.find((agent) => agent.id === linkedAgentId) || selectedAgent
  }, [agents, selectedAgent, selectedSession])

  const selectedWorkspace = useMemo(() => {
    const linkedWorkspaceId = sessionWorkspaceId(selectedSession)
    return workspaces.find((workspace) => workspace.id === linkedWorkspaceId) || selectedSession?.workspace || null
  }, [selectedSession, workspaces])

  const chatMessages = useMemo(() => {
    const messages = []

    for (const item of items) {
      const reasoning = reasoningItemText(item)
      if (reasoning) {
        messages.push({
          id: item.id,
          role: 'thinking',
          text: reasoning,
        })
        continue
      }

      if (item.type?.includes('message') || item.role) {
        const text = itemText(item)
        if (text) {
          messages.push({
            id: item.id,
            role: item.role || (item.type?.includes('assistant') ? 'assistant' : 'user'),
            text,
          })
        }
      }

      if (item.type === 'command_execution') {
        messages.push({
          id: item.id,
          role: 'tool',
          text: `${item.command}\n${item.output || ''}`.trim(),
        })
      }
    }

    if (liveReasoning) {
      messages.push({
        id: 'live-reasoning',
        role: 'thinking',
        text: liveReasoning,
      })
    }

    if (liveText) {
      messages.push({
        id: 'live',
        role: 'assistant',
        text: liveText,
      })
    }

    return messages
  }, [items, liveReasoning, liveText])

  const activitySteps = useMemo(() => {
    const fromEvents = events.map((event, index) => ({
      id: event.id || `${event.type || 'event'}-${index}`,
      ...activityLabel(event),
    }))

    if (fromEvents.length > 0) return fromEvents

    return turns.map((turn, index) => ({
      id: turn.id || `turn-${index}`,
      title: `Turn ${turn.status || 'recorded'}`,
      detail: compactJson({
        id: turn.id,
        status: turn.status,
        created_at: readableTime(turn.created_at),
      }),
    }))
  }, [events, turns])

  async function loadStatus() {
    setStatus(await api('/api/status'))
  }

  async function loadRuntime(nextUserId = userId) {
    const runtimeState = await api(`/api/control-plane/users/${nextUserId}/runtime`)
    setRuntime(runtimeState.runtime)
    setWorkspaces(runtimeState.workspaces || [])
  }

  async function ensureRuntime(event) {
    event?.preventDefault()
    setBusy(true)
    setError('')

    try {
      const runtimeState = await api(`/api/control-plane/users/${userId}/runtime`, {
        method: 'POST',
        body: JSON.stringify({ displayName: userId }),
      })
      setRuntime(runtimeState.runtime)
      await loadRuntime(userId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function loadAgents() {
    const nextAgents = rows(await api('/api/agents?limit=50'))
    setAgents(nextAgents)
    if (!selectedAgentId && nextAgents[0]) {
      setSelectedAgentId(nextAgents[0].id)
    }
  }

  async function loadSessions() {
    const nextSessions = rows(await api('/api/sessions?limit=50'))
    setSessions(nextSessions)
    if (!selectedSessionId && nextSessions[0]) {
      setSelectedSessionId(nextSessions[0].id)
      await loadSession(nextSessions[0].id)
    }
  }

  async function loadSession(sessionId = selectedSessionId) {
    if (!sessionId) return

    const [session, nextItems, nextTurns] = await Promise.all([
      api(`/api/sessions/${sessionId}`),
      api(`/api/sessions/${sessionId}/items?limit=100&order=asc`),
      api(`/api/sessions/${sessionId}/turns?limit=50&order=desc`),
    ])

    setSelectedSession(session)
    setItems(rows(nextItems))
    setTurns(rows(nextTurns))

    const linkedAgentId = sessionAgentId(session)
    if (linkedAgentId) {
      setSelectedAgentId(linkedAgentId)
    }

    const linkedWorkspaceId = sessionWorkspaceId(session)
    if (linkedWorkspaceId) {
      await loadWorkspaceFiles(linkedWorkspaceId)
    } else {
      setWorkspaceFiles([])
    }
  }

  async function loadWorkspaceFiles(workspaceId = selectedWorkspace?.id) {
    if (!workspaceId) return

    const result = await api(`/api/control-plane/workspaces/${workspaceId}/files`)
    setWorkspaceFiles(result.files || [])
  }

  async function refreshAll() {
    setError('')
    try {
      await loadStatus()
      await ensureRuntime()
      await loadAgents()
      await loadSessions()
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    refreshAll()
  }, [])

  async function createAgent(event) {
    event.preventDefault()
    setBusy(true)
    setError('')

    try {
      const agent = await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify(agentDraft),
      })
      setSelectedAgentId(agent.id)
      await loadAgents()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function createChat(event) {
    event.preventDefault()
    if (!selectedAgent) {
      setError('Select or create an agent before creating a chat.')
      setActiveSideTab('agents')
      return
    }

    if (!sessionDraft.initialInput.trim()) {
      setError('Add an initial message before creating a chat.')
      return
    }

    setBusy(true)
    setError('')
    setLiveText('')
    setLiveReasoning('')
    setEvents([])

    try {
      const session = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          agentId: selectedAgent.id,
          agentName: selectedAgent.name || 'Unnamed agent',
          agentModel: selectedAgent.model || status.defaultModel || defaultModel,
          userId,
          environmentType: sessionDraft.environmentType,
          input: sessionDraft.initialInput,
          metadata: JSON.stringify({
            label: selectedAgent.name || 'Agent chat',
            user_id: userId,
            agent_id: selectedAgent.id,
            agent_name: selectedAgent.name || 'Unnamed agent',
            agent_model: selectedAgent.model || status.defaultModel || defaultModel,
          }),
        }),
      })

      setSelectedSessionId(session.id)
      setSelectedSession(session)
      setActiveSideTab('chats')
      await loadSessions()
      await loadRuntime(userId)
      await loadSession(session.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function saveWorkspaceFile(event) {
    event.preventDefault()
    if (!selectedWorkspace?.id) {
      setError('Select a chat with a workspace before adding files.')
      return
    }

    setBusy(true)
    setError('')

    try {
      await api(`/api/control-plane/workspaces/${selectedWorkspace.id}/files`, {
        method: 'PUT',
        body: JSON.stringify(fileDraft),
      })
      await loadWorkspaceFiles(selectedWorkspace.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function runWorkspaceBash(event) {
    event.preventDefault()
    if (!selectedWorkspace?.id) {
      setError('Select a chat with a workspace before running workspace bash.')
      return
    }

    setBusy(true)
    setError('')

    try {
      const result = await api(`/api/control-plane/workspaces/${selectedWorkspace.id}/bash`, {
        method: 'POST',
        body: JSON.stringify(bashDraft),
      })
      setBashResult(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    if (!selectedSessionId || !prompt.trim()) return

    const userText = prompt
    setPrompt('')
    setBusy(true)
    setError('')
    setLiveText('')
    setLiveReasoning('')
    setEvents([])
    setItems((current) => [
      ...current,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: [{ text: userText }],
      },
    ])

    try {
      const response = await fetch(`/api/sessions/${selectedSessionId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: userText }),
      })

      if (!response.ok || !response.body) {
        throw new Error(await response.text())
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const nextEvents = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() || ''

        for (const chunk of chunks) {
          const line = chunk.split('\n').find((entry) => entry.startsWith('data: '))
          if (!line) continue

          const parsed = JSON.parse(line.slice(6))
          nextEvents.push(parsed)
          setEvents([...nextEvents])
          setLiveText(eventText(nextEvents))
          setLiveReasoning(reasoningEventText(nextEvents))
        }
      }

      await loadSession(selectedSessionId)
      setLiveText('')
      setLiveReasoning('')
    } catch (err) {
      setError(err.message)
      setPrompt(userText)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidepanel">
        <div className="brand-block">
          <p className="eyebrow">OpenAI Agents API</p>
          <h1>Agent Lab</h1>
          <span>{status.ok ? 'API key ready' : 'API key missing'}</span>
        </div>

        <nav className="side-tabs" aria-label="Primary">
          <button
            type="button"
            className={activeSideTab === 'agents' ? 'active' : ''}
            onClick={() => setActiveSideTab('agents')}
          >
            Agents
          </button>
          <button
            type="button"
            className={activeSideTab === 'chats' ? 'active' : ''}
            onClick={() => setActiveSideTab('chats')}
          >
            Chats
          </button>
          <button
            type="button"
            className={activeSideTab === 'runtime' ? 'active' : ''}
            onClick={() => setActiveSideTab('runtime')}
          >
            Runtime
          </button>
        </nav>

        {activeSideTab === 'agents' && (
          <section className="side-section">
            <form className="create-form" onSubmit={createAgent}>
              <label>
                Name
                <input
                  value={agentDraft.name}
                  onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })}
                />
              </label>
              <label>
                Model
                <select
                  value={agentDraft.model}
                  onChange={(event) => setAgentDraft({ ...agentDraft, model: event.target.value })}
                >
                  <option value="gpt-5.6-luna">gpt-5.6-luna</option>
                  <option value="gpt-5.6-terra">gpt-5.6-terra</option>
                  <option value="gpt-5.6-sol">gpt-5.6-sol</option>
                  <option value="gpt-6-astra">gpt-6-astra</option>
                </select>
              </label>
              <label>
                Instructions
                <textarea
                  value={agentDraft.instructions}
                  onChange={(event) =>
                    setAgentDraft({ ...agentDraft, instructions: event.target.value })
                  }
                />
              </label>
              <label>
                Tools JSON
                <textarea
                  value={agentDraft.tools}
                  onChange={(event) => setAgentDraft({ ...agentDraft, tools: event.target.value })}
                />
              </label>
              <label>
                Reasoning JSON
                <textarea
                  value={agentDraft.reasoning}
                  onChange={(event) =>
                    setAgentDraft({ ...agentDraft, reasoning: event.target.value })
                  }
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={agentDraft.multiAgentEnabled}
                  onChange={(event) =>
                    setAgentDraft({ ...agentDraft, multiAgentEnabled: event.target.checked })
                  }
                />
                Enable subagents
              </label>
              <button type="submit" disabled={busy || !status.ok}>
                Create Agent
              </button>
            </form>

            <div className="nav-list">
              {agents.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  className={agent.id === selectedAgentId ? 'nav-item selected' : 'nav-item'}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <strong>{agent.name || 'Unnamed agent'}</strong>
                  <span>{agent.model}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {activeSideTab === 'chats' && (
          <section className="side-section">
            <form className="create-form compact" onSubmit={createChat}>
              <label>
                Workspace
                <select
                  value={sessionDraft.environmentType}
                  onChange={(event) =>
                    setSessionDraft({ ...sessionDraft, environmentType: event.target.value })
                  }
                >
                  <option value="none">No workspace</option>
                  <option value="openai_hosted">OpenAI hosted</option>
                </select>
              </label>
              <label>
                Agent
                <select
                  value={selectedAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                >
                  <option value="">Select an agent</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name || agent.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Initial Message
                <textarea
                  value={sessionDraft.initialInput}
                  onChange={(event) =>
                    setSessionDraft({ ...sessionDraft, initialInput: event.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={busy || !status.ok || !selectedAgentId}>
                New Chat
              </button>
            </form>

            <div className="nav-list">
              {sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={session.id === selectedSessionId ? 'nav-item selected' : 'nav-item'}
                  onClick={() => {
                    setSelectedSessionId(session.id)
                    setLiveText('')
                    setLiveReasoning('')
                    setEvents([])
                    loadSession(session.id).catch((err) => setError(err.message))
                  }}
                >
                  <strong>{session.metadata?.label || session.status || 'Agent chat'}</strong>
                  <span>{session.metadata?.agent_name || sessionAgentId(session) || session.id}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {activeSideTab === 'runtime' && (
          <section className="side-section">
            <form className="create-form compact" onSubmit={ensureRuntime}>
              <label>
                User
                <input
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy || !userId.trim()}>
                Ensure Runtime
              </button>
            </form>

            <div className="runtime-card">
              <span>Provider</span>
              <strong>{runtime?.provider || 'local'}</strong>
              <span>Image</span>
              <strong>{runtime?.image || 'agent-runtime:local'}</strong>
              <span>Pod</span>
              <strong>{runtime?.podName || 'Not provisioned'}</strong>
              <span>PVC</span>
              <strong>{runtime?.pvcName || 'Not provisioned'}</strong>
              <span>Namespace</span>
              <strong>{runtime?.namespace || 'agent-lab'}</strong>
            </div>

            <div className="nav-list">
              {workspaces.map((workspace) => (
                <button
                  type="button"
                  key={workspace.id}
                  className={workspace.id === selectedWorkspace?.id ? 'nav-item selected' : 'nav-item'}
                  onClick={() => loadWorkspaceFiles(workspace.id).catch((err) => setError(err.message))}
                >
                  <strong>{workspace.agentName || workspace.sessionId}</strong>
                  <span>{workspace.runtimePath}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div>
            <h2>{selectedSessionAgent?.name || 'Select or create an agent'}</h2>
            <p>{selectedSessionAgent?.model || status.defaultModel || defaultModel}</p>
          </div>
          <button type="button" onClick={refreshAll}>
            Refresh
          </button>
        </header>

        {error && <section className="error-panel">{error}</section>}

        <section className="workspace-shell">
          <section className="chat-panel">
            <div className="chat-history">
              {chatMessages.length === 0 && (
                <div className="empty-state">
                  Create a chat from the sidebar, then send a prompt here.
                </div>
              )}

              {chatMessages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span>{message.role}</span>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>

            <form className="composer" onSubmit={sendMessage}>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Send a message to the selected agent session"
              />
              <button type="submit" disabled={busy || !selectedSessionId || !status.ok}>
                {busy ? 'Running' : 'Send'}
              </button>
            </form>
          </section>

          <aside className="context-panel">
            <section className="context-card workspace-band">
              <div>
                <span>Chat</span>
                <strong>{selectedSessionId || 'No chat selected'}</strong>
              </div>
              <div>
                <span>Agent</span>
                <strong>{selectedSessionAgent?.name || 'No agent selected'}</strong>
              </div>
              <div>
                <span>Workspace</span>
                <strong>{selectedWorkspace?.runtimePath || selectedSession?.environment?.type || sessionDraft.environmentType}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{selectedSession?.status || 'idle'}</strong>
              </div>
            </section>

            <section className="context-card agent-config-band">
              <div>
                <span>Instructions</span>
                <p>{selectedSessionAgent?.instructions || 'Select a chat to see the linked agent instructions.'}</p>
              </div>
              <div>
                <span>Tools</span>
                <pre>{formatTools(selectedSessionAgent?.tools)}</pre>
              </div>
            </section>

            <section className="context-card workspace-tools">
              <div className="workspace-files">
                <span>Session Workspace Files</span>
                {workspaceFiles.length === 0 ? (
                  <p>No files uploaded yet.</p>
                ) : (
                  <ul>
                    {workspaceFiles.map((file) => (
                      <li key={file.path}>
                        {file.type === 'directory' ? '[dir]' : '[file]'} {file.path}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form className="file-form" onSubmit={saveWorkspaceFile}>
                <label>
                  Path
                  <input
                    value={fileDraft.path}
                    onChange={(event) => setFileDraft({ ...fileDraft, path: event.target.value })}
                  />
                </label>
                <label>
                  Content
                  <textarea
                    value={fileDraft.content}
                    onChange={(event) => setFileDraft({ ...fileDraft, content: event.target.value })}
                  />
                </label>
                <button type="submit" disabled={busy || !selectedWorkspace?.id}>
                  Add File
                </button>
              </form>

              <form className="bash-form" onSubmit={runWorkspaceBash}>
                <label>
                  CWD
                  <input
                    value={bashDraft.cwd}
                    onChange={(event) => setBashDraft({ ...bashDraft, cwd: event.target.value })}
                  />
                </label>
                <label>
                  Read-only Bash
                  <input
                    value={bashDraft.command}
                    onChange={(event) => setBashDraft({ ...bashDraft, command: event.target.value })}
                    placeholder="ls, cat files/notes.md, find skills"
                  />
                </label>
                <button type="submit" disabled={busy || !selectedWorkspace?.id}>
                  Run
                </button>
                {bashResult && (
                  <pre>
                    {[
                      `$ ${bashResult.command}`,
                      bashResult.stdout,
                      bashResult.stderr ? `stderr:\n${bashResult.stderr}` : '',
                      `exit ${bashResult.exitCode}`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </pre>
                )}
              </form>
            </section>

            <section className="context-card inspector">
              <div className="inspector-tabs">
                <button
                  type="button"
                  className={activeInspectorTab === 'activity' ? 'active' : ''}
                  onClick={() => setActiveInspectorTab('activity')}
                >
                  Activity
                </button>
                <button
                  type="button"
                  className={activeInspectorTab === 'items' ? 'active' : ''}
                  onClick={() => setActiveInspectorTab('items')}
                >
                  Items
                </button>
                <button
                  type="button"
                  className={activeInspectorTab === 'turns' ? 'active' : ''}
                  onClick={() => setActiveInspectorTab('turns')}
                >
                  Turns
                </button>
                <button
                  type="button"
                  className={activeInspectorTab === 'events' ? 'active' : ''}
                  onClick={() => setActiveInspectorTab('events')}
                >
                  Events
                </button>
              </div>
              {activeInspectorTab === 'activity' ? (
                <div className="activity-list">
                  {activitySteps.length === 0 ? (
                    <p>No activity yet. Send a message to see assistant steps and tool calls here.</p>
                  ) : (
                    activitySteps.map((step) => (
                      <article key={step.id} className="activity-step">
                        <span>{step.title}</span>
                        {step.detail && <p>{step.detail}</p>}
                      </article>
                    ))
                  )}
                </div>
              ) : (
                <pre>
                  {JSON.stringify(
                    activeInspectorTab === 'items'
                      ? items
                      : activeInspectorTab === 'turns'
                        ? turns
                        : events,
                    null,
                    2,
                  )}
                </pre>
              )}
            </section>
          </aside>
        </section>
      </section>
    </main>
  )
}

export default App
