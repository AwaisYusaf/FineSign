import { useEffect, useState } from "react";
import { listWebhooks, createWebhook, deleteWebhook, deliverWebhooks } from "../api.js";

// Audit event types a subscription can filter on (empty selection = all events).
const EVENT_TYPES = [
  "envelope_sent",
  "recipient_viewed",
  "recipient_signed",
  "recipient_declined",
  "envelope_completed",
  "envelope_voided",
  "envelope_expired",
];

export default function Webhooks() {
  const [subs, setSubs] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [types, setTypes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [createdSecret, setCreatedSecret] = useState(null);

  async function load() {
    try {
      const { subscriptions } = await listWebhooks();
      setSubs(subscriptions);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function onCreate(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCreatedSecret(null);
    setBusy(true);
    try {
      const created = await createWebhook({
        url,
        secret: secret.trim() === "" ? undefined : secret.trim(),
        eventTypes: types.length === 0 ? null : types,
      });
      // The signing secret is shown exactly once — surface it so the operator can copy it.
      setCreatedSecret(created.secret);
      setUrl("");
      setSecret("");
      setTypes([]);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this webhook endpoint?")) return;
    try {
      await deleteWebhook(id);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function onDeliver() {
    setError(null);
    try {
      const summary = await deliverWebhooks();
      setNotice(`Drained: ${summary.delivered} delivered, ${summary.retried} retried, ${summary.dead} dead-lettered.`);
    } catch (e) {
      setError(e.message);
    }
  }

  function toggleType(t) {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Webhooks</h1>
        <button className="btn ghost" onClick={onDeliver}>Deliver now</button>
      </div>
      <p className="muted">
        Endpoints receive an HTTP POST for each matching envelope event, signed with{" "}
        <code>X-FineSign-Signature: sha256=HMAC(secret, "&lt;timestamp&gt;.&lt;body&gt;")</code>.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      {createdSecret && (
        <div className="card" style={{ borderColor: "var(--accent, #2b7)" }}>
          <h3>Signing secret (shown once)</h3>
          <p className="muted">Copy it now — it will not be shown again. Verify it on incoming requests.</p>
          <code style={{ wordBreak: "break-all" }}>{createdSecret}</code>
        </div>
      )}

      <div className="card">
        <h2>Add endpoint</h2>
        <form onSubmit={onCreate}>
          <label className="field">
            <span>Endpoint URL (https)</span>
            <input type="url" placeholder="https://example.com/finesign/webhook" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </label>
          <label className="field">
            <span>Signing secret (optional — generated if blank, min 16 chars)</span>
            <input type="text" placeholder="Leave blank to auto-generate" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <span>Events (none selected = all)</span>
            <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 4 }}>
              {EVENT_TYPES.map((t) => (
                <label key={t} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} /> {t}
                </label>
              ))}
            </div>
          </fieldset>
          <button className="btn" disabled={busy}>Add webhook</button>
        </form>
      </div>

      <div className="card">
        <h2>Endpoints</h2>
        {!subs && <p className="muted">Loading…</p>}
        {subs && subs.length === 0 && <p className="muted">No webhook endpoints configured.</p>}
        {subs && subs.length > 0 && (
          <table>
            <thead><tr><th>URL</th><th>Events</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td style={{ wordBreak: "break-all" }}>{s.url}</td>
                  <td className="muted">{s.eventTypes === null ? "all" : s.eventTypes.join(", ")}</td>
                  <td>{s.active ? "yes" : "no"}</td>
                  <td><button className="btn ghost small" onClick={() => onDelete(s.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
