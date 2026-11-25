import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  decryptNote,
  deriveWorkspaceKey,
  encryptNote,
  getWorkspacePassphrase,
  setWorkspacePassphrase,
} from './crypto';

interface WorkspaceMembership {
  id: string;
  role: string;
}

interface User {
  sub: string;
  name: string;
  email: string;
  workspaces: WorkspaceMembership[];
}

interface Conversation {
  workspace: string;
  contact: string;
  status: 'open' | 'closed';
  assignee: string | null;
  last_activity_at: string | null;
  last_message?: {
    text: string;
    direction: string;
    status: string;
    occurred_at: string;
  } | null;
}

interface Message {
  _id?: string;
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  message_id?: string;
  client_ref?: string;
  text: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  occurred_at: string;
}

interface PrivateNote {
  _id?: string;
  workspace: string;
  contact: string;
  author_sub: string;
  author_name: string;
  ciphertext: string;
  iv: string;
  alg: 'AES-GCM-256';
  key_id: string;
  created_at: string;
}

type TimelineItem =
  | { kind: 'message'; key: string; ts: number; data: Message }
  | { kind: 'note'; key: string; ts: number; data: PrivateNote };

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspace, setWorkspace] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<PrivateNote[]>([]);
  const [wsStatus, setWsStatus] = useState<'live' | 'reconnecting'>('reconnecting');
  const [composerMode, setComposerMode] = useState<'reply' | 'note'>('reply');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notePassphrase, setNotePassphrase] = useState('');
  const [noteKey, setNoteKey] = useState<{ key: CryptoKey; keyId: string } | null>(null);
  const [decryptedNotes, setDecryptedNotes] = useState<Record<string, string | null>>({});

  const lastSeqRef = useRef<number | null>(null);
  const selectedContactRef = useRef<string | null>(null);
  selectedContactRef.current = selectedContact;

  useEffect(() => {
    if (!workspace) {
      setNoteKey(null);
      return;
    }
    const pass = getWorkspacePassphrase(workspace);
    setNotePassphrase(pass);
    let cancelled = false;
    deriveWorkspaceKey(workspace, pass)
      .then((derived) => {
        if (!cancelled) setNoteKey(derived);
      })
      .catch(() => {
        if (!cancelled) setNoteKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    if (!noteKey || notes.length === 0) {
      setDecryptedNotes({});
      return;
    }
    let cancelled = false;
    Promise.all(
      notes.map(async (n, idx) => {
        const k = n._id || `n_${idx}`;
        const plain = await decryptNote(noteKey.key, n.ciphertext, n.iv);
        return [k, plain] as const;
      })
    ).then((entries) => {
      if (!cancelled) setDecryptedNotes(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [notes, noteKey]);

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: User | null) => {
        setUser(data);
        if (data && data.workspaces.length > 0) {
          setWorkspace(data.workspaces[0].id);
        }
      })
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  const loadConversations = useCallback(
    async (ws: string, filter: 'all' | 'open' | 'closed', cursor?: string) => {
      if (!ws) return;
      const params = new URLSearchParams({ workspace: ws, status: filter, limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/conversations?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        conversations: Conversation[];
        next_cursor: string | null;
      };
      if (cursor) {
        setConversations((prev) => [...prev, ...data.conversations]);
      } else {
        setConversations(data.conversations);
      }
      setNextCursor(data.next_cursor);
    },
    []
  );

  const loadThread = useCallback(async (ws: string, contact: string) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(ws)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      conversation: Conversation;
      messages: Message[];
      notes: PrivateNote[];
    };
    setActiveConv(data.conversation);
    setMessages(data.messages);
    setNotes(data.notes);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setSelectedContact(null);
    setActiveConv(null);
    setMessages([]);
    setNotes([]);
    lastSeqRef.current = null;
    void loadConversations(workspace, statusFilter);
  }, [workspace, statusFilter, loadConversations]);

  useEffect(() => {
    if (!workspace || !selectedContact) return;
    setActionError(null);
    void loadThread(workspace, selectedContact);
  }, [workspace, selectedContact, loadThread]);

  // Real-time WebSocket connection with automatic after=<seq> replay
  useEffect(() => {
    if (!user || !workspace) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const afterPart =
        lastSeqRef.current !== null ? `&after=${encodeURIComponent(lastSeqRef.current)}` : '';
      const url = `${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}${afterPart}`;
      socket = new WebSocket(url);

      socket.addEventListener('open', () => {
        if (!cancelled) setWsStatus('live');
      });

      socket.addEventListener('message', (evt) => {
        try {
          const frame = JSON.parse(String(evt.data)) as Record<string, unknown>;
          if (typeof frame.seq === 'number') {
            lastSeqRef.current = Math.max(lastSeqRef.current ?? -1, frame.seq);
          }

          const type = frame.type;
          const contact = typeof frame.contact === 'string' ? frame.contact : '';
          if (!contact) return;

          if (type === 'message.inbound') {
            const msg: Message = {
              workspace,
              contact,
              direction: 'inbound',
              message_id: String(frame.message_id || ''),
              text: String(frame.text || ''),
              status: 'delivered',
              occurred_at: String(frame.occurred_at || new Date().toISOString()),
            };

            setConversations((prev) => {
              const existing = prev.find((c) => c.contact === contact);
              const updated: Conversation = existing
                ? {
                    ...existing,
                    last_activity_at: msg.occurred_at,
                    last_message: {
                      text: msg.text,
                      direction: 'inbound',
                      status: 'delivered',
                      occurred_at: msg.occurred_at,
                    },
                  }
                : {
                    workspace,
                    contact,
                    status: 'open',
                    assignee: null,
                    last_activity_at: msg.occurred_at,
                    last_message: {
                      text: msg.text,
                      direction: 'inbound',
                      status: 'delivered',
                      occurred_at: msg.occurred_at,
                    },
                  };
              return [updated, ...prev.filter((c) => c.contact !== contact)];
            });

            if (selectedContactRef.current === contact) {
              setMessages((prev) => {
                if (msg.message_id && prev.some((m) => m.message_id === msg.message_id)) {
                  return prev;
                }
                return [...prev, msg];
              });
            }
          } else if (type === 'message.outbound') {
            const clientRef = String(frame.client_ref || '');
            const text = String(frame.text || '');
            const nowIso = new Date().toISOString();
            const msg: Message = {
              workspace,
              contact,
              direction: 'outbound',
              client_ref: clientRef,
              text,
              status: 'queued',
              occurred_at: nowIso,
            };

            setConversations((prev) => {
              const existing = prev.find((c) => c.contact === contact);
              if (!existing) return prev;
              const updated: Conversation = {
                ...existing,
                last_activity_at: nowIso,
                last_message: {
                  text,
                  direction: 'outbound',
                  status: 'queued',
                  occurred_at: nowIso,
                },
              };
              return [updated, ...prev.filter((c) => c.contact !== contact)];
            });

            if (selectedContactRef.current === contact) {
              setMessages((prev) => {
                if (clientRef && prev.some((m) => m.client_ref === clientRef)) {
                  return prev;
                }
                return [...prev, msg];
              });
            }
          } else if (type === 'message.status') {
            const clientRef = String(frame.client_ref || '');
            const status = frame.status as Message['status'];
            if (selectedContactRef.current === contact) {
              setMessages((prev) =>
                prev.map((m) => (m.client_ref === clientRef ? { ...m, status } : m))
              );
            }
          } else if (type === 'conversation.assigned') {
            const assignee = (frame.assignee as string | null) ?? null;
            setConversations((prev) =>
              prev.map((c) => (c.contact === contact ? { ...c, assignee } : c))
            );
            if (selectedContactRef.current === contact) {
              setActiveConv((prev) => (prev ? { ...prev, assignee } : prev));
            }
          } else if (type === 'conversation.status') {
            const status = frame.status as 'open' | 'closed';
            setConversations((prev) =>
              prev.map((c) => (c.contact === contact ? { ...c, status } : c))
            );
            if (selectedContactRef.current === contact) {
              setActiveConv((prev) => (prev ? { ...prev, status } : prev));
            }
          } else if (type === 'note.created') {
            const note = frame.note as PrivateNote | undefined;
            if (note && selectedContactRef.current === contact) {
              setNotes((prev) => {
                if (note._id && prev.some((n) => n._id === note._id)) return prev;
                return [...prev, note];
              });
            }
          }
        } catch {
          // ignore malformed frame
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) return;
        setWsStatus('reconnecting');
        reconnectTimer = setTimeout(connect, 1500);
      });

      socket.addEventListener('error', () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [user, workspace]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...messages.map((m, i) => ({
        kind: 'message' as const,
        key: m._id || m.message_id || m.client_ref || `m_${i}`,
        ts: new Date(m.occurred_at).getTime() || 0,
        data: m,
      })),
      ...notes.map((n, i) => ({
        kind: 'note' as const,
        key: n._id || `n_${i}`,
        ts: new Date(n.created_at).getTime() || 0,
        data: n,
      })),
    ];
    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [messages, notes]);

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
  }

  async function handleClaimToggle() {
    if (!activeConv || !workspace) return;
    setActionError(null);
    const isMine = activeConv.assignee === user?.sub;
    const endpoint = isMine ? 'unclaim' : 'claim';
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(activeConv.contact)}/${endpoint}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace }),
      }
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setActionError(err.error || `Failed to ${endpoint}`);
    }
  }

  async function handleStatusToggle() {
    if (!activeConv || !workspace) return;
    setActionError(null);
    const nextStatus = activeConv.status === 'open' ? 'closed' : 'open';
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(activeConv.contact)}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, status: nextStatus }),
      }
    );
    if (!res.ok) {
      setActionError('Failed to update status');
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!selectedContact || !workspace || !draft.trim() || sending) return;
    setSending(true);
    setActionError(null);
    try {
      const text = draft.trim();
      if (composerMode === 'reply') {
        const client_ref = `ui_${crypto.randomUUID()}`;
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(selectedContact)}/reply`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace, text, client_ref }),
          }
        );
        if (!res.ok) {
          setActionError('Failed to send reply');
          return;
        }
      } else {
        if (!noteKey) {
          setActionError('Encryption key not ready');
          return;
        }
        const { ciphertext, iv } = await encryptNote(noteKey.key, text);
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(selectedContact)}/notes`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspace,
              ciphertext,
              iv,
              alg: 'AES-GCM-256',
              key_id: noteKey.keyId,
            }),
          }
        );
        if (!res.ok) {
          setActionError('Failed to save note');
          return;
        }
      }
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  async function handlePassphraseChange(nextPass: string) {
    setNotePassphrase(nextPass);
    if (!workspace) return;
    setWorkspacePassphrase(workspace, nextPass);
    const derived = await deriveWorkspaceKey(workspace, nextPass || getWorkspacePassphrase(workspace));
    setNoteKey(derived);
  }

  if (authLoading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Loading session…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Shared team inbox for customer support</p>
          <a className="btn-primary" href="/auth/login">
            Sign in with Switchboard IdP
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Switchboard</span>
          <select
            className="ws-select"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
          <span className={`ws-badge ${wsStatus}`}>
            {wsStatus === 'live' ? '● Live' : '● Reconnecting'}
          </span>
        </div>

        <div className="topbar-right">
          <span>
            {user.name} ({user.sub})
          </span>
          <button className="btn-secondary" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="inbox-grid">
        {/* Left Column: Conversation List */}
        <aside className="col-list">
          <div className="filter-bar">
            {(['all', 'open', 'closed'] as const).map((f) => (
              <button
                key={f}
                className={`filter-tab ${statusFilter === f ? 'active' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="conv-scroll">
            {conversations.length === 0 ? (
              <div className="empty-state" style={{ padding: 24 }}>
                No conversations yet
              </div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.contact}
                  className={`conv-item ${selectedContact === c.contact ? 'selected' : ''}`}
                  onClick={() => setSelectedContact(c.contact)}
                >
                  <div className="conv-item-top">
                    <span className="conv-contact">{c.contact}</span>
                    <span className="conv-time">{formatTime(c.last_activity_at)}</span>
                  </div>
                  <div className="conv-preview">
                    {c.last_message ? c.last_message.text : 'No messages yet'}
                  </div>
                  <div className="conv-meta">
                    <span className={`pill ${c.status}`}>{c.status}</span>
                    <span className={`pill ${c.assignee ? 'assignee' : 'unassigned'}`}>
                      {c.assignee || 'Unassigned'}
                    </span>
                  </div>
                </div>
              ))
            )}
            {nextCursor && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                <button
                  className="btn-secondary"
                  onClick={() => loadConversations(workspace, statusFilter, nextCursor)}
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Center Column: Message Thread */}
        <main className="col-thread">
          {!selectedContact || !activeConv ? (
            <div className="empty-state">Select a conversation to view messages</div>
          ) : (
            <>
              <div className="thread-header">
                <div>
                  <strong>{activeConv.contact}</strong>{' '}
                  <span className={`pill ${activeConv.status}`}>{activeConv.status}</span>
                </div>
                <div className="thread-actions">
                  <button className="btn-secondary" onClick={handleClaimToggle}>
                    {activeConv.assignee === user.sub
                      ? 'Release'
                      : activeConv.assignee
                        ? `Held by ${activeConv.assignee}`
                        : 'Claim'}
                  </button>
                  <button className="btn-secondary" onClick={handleStatusToggle}>
                    {activeConv.status === 'open' ? 'Close' : 'Reopen'}
                  </button>
                </div>
              </div>

              {actionError && (
                <div
                  style={{
                    background: '#fee2e2',
                    color: '#991b1b',
                    padding: '6px 16px',
                    fontSize: 13,
                  }}
                >
                  {actionError}
                </div>
              )}

              <div className="messages-scroll">
                {timeline.map((item) => {
                  if (item.kind === 'note') {
                    const plain = decryptedNotes[item.key];
                    return (
                      <div key={item.key} className="msg-row note">
                        <div className="bubble">
                          <strong>🔒 Internal Note ({item.data.author_name}):</strong>{' '}
                          {plain === undefined
                            ? 'Decrypting…'
                            : plain === null
                              ? 'Unable to decrypt (wrong workspace key)'
                              : plain}
                        </div>
                        <div className="msg-footer">
                          <span>{formatTime(item.data.created_at)}</span>
                          <span>
                            {item.data.alg} · key:{item.data.key_id}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  const m = item.data;
                  return (
                    <div key={item.key} className={`msg-row ${m.direction}`}>
                      <div className="bubble">{m.text}</div>
                      <div className="msg-footer">
                        <span>{formatTime(m.occurred_at)}</span>
                        {m.direction === 'outbound' && (
                          <span className={`status-tag ${m.status}`}>{m.status}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="composer">
                <div className="composer-mode">
                  <button
                    type="button"
                    className={`mode-btn ${composerMode === 'reply' ? 'active-reply' : ''}`}
                    onClick={() => setComposerMode('reply')}
                  >
                    Reply (Customer)
                  </button>
                  <button
                    type="button"
                    className={`mode-btn ${composerMode === 'note' ? 'active-note' : ''}`}
                    onClick={() => setComposerMode('note')}
                  >
                    🔒 Internal Note (E2EE)
                  </button>
                </div>
                <form className="composer-form" onSubmit={handleSend}>
                  <input
                    className="composer-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={
                      composerMode === 'reply'
                        ? 'Write a reply to the customer…'
                        : 'Write an end-to-end encrypted note for your team…'
                    }
                  />
                  <button className="btn-primary" type="submit" disabled={sending || !draft.trim()}>
                    {composerMode === 'reply' ? 'Send' : 'Add Note'}
                  </button>
                </form>
              </div>
            </>
          )}
        </main>

        {/* Right Column: Details */}
        <aside className="col-details">
          <div className="detail-group">
            <div className="detail-label">Workspace</div>
            <div>{workspace}</div>
          </div>
          <div className="detail-group">
            <div className="detail-label">Note Encryption Key (E2EE)</div>
            <input
              type="password"
              value={notePassphrase}
              onChange={(e) => void handlePassphraseChange(e.target.value)}
              placeholder="Workspace passphrase"
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                fontSize: 12,
              }}
            />
            {noteKey && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                AES-GCM-256 · key:{noteKey.keyId}
              </div>
            )}
          </div>
          {activeConv ? (
            <>
              <div className="detail-group">
                <div className="detail-label">Contact</div>
                <div>{activeConv.contact}</div>
              </div>
              <div className="detail-group">
                <div className="detail-label">Status</div>
                <span className={`pill ${activeConv.status}`}>{activeConv.status}</span>
              </div>
              <div className="detail-group">
                <div className="detail-label">Assignee</div>
                <span className={`pill ${activeConv.assignee ? 'assignee' : 'unassigned'}`}>
                  {activeConv.assignee || 'Unassigned'}
                </span>
              </div>
              <div className="detail-group">
                <div className="detail-label">Internal Notes</div>
                <div>{notes.length} note(s)</div>
              </div>
            </>
          ) : (
            <div style={{ color: '#6b7280' }}>No conversation selected.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
