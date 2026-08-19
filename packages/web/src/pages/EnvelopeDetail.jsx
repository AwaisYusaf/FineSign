import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getEnvelope, voidEnvelope, getDevLinks, managementDocUrl, resendRecipient, remindRecipient } from "../api.js";
import { getApiKey } from "../config.js";

export default function EnvelopeDetail() {
  const { id } = useParams();
  const [env, setEnv] = useState(null);
  const [links, setLinks] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function load() {
    try {
      const e = await getEnvelope(id);
      setEnv(e);
      if (e.status === "sent") {
        const { links: l } = await getDevLinks(id);
        setLinks(l);
      }
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function doVoid() {
    const reason = window.prompt("Reason for voiding?");
    if (reason == null) return;
    try {
      await voidEnvelope(id, reason);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function nudge(recipientId, kind) {
    setError(null);
    setNotice(null);
    try {
      if (kind === "resend") await resendRecipient(id, recipientId);
      else await remindRecipient(id, recipientId);
      setNotice(kind === "resend" ? "Signing link re-sent." : "Reminder sent.");
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  // A recipient can be nudged only while the envelope is out and it's their turn
  // (the server enforces this too; the button just avoids obvious dead clicks).
  const canNudge = (r) => env.status === "sent" && (r.status === "notified" || r.status === "viewed");

  function download(documentId) {
    // Fetch with the API key, then open the blob (the route needs the header).
    fetch(managementDocUrl(id, documentId), { headers: { authorization: `Bearer ${getApiKey()}` } })
      .then((r) => r.blob())
      .then((b) => window.open(URL.createObjectURL(b), "_blank"));
  }

  if (error) return <div className="error">{error}</div>;
  if (!env) return <p className="muted">Loading…</p>;

  return (
    <div>
      <p><Link to="/">← Envelopes</Link></p>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{env.title}</h1>
        <span className={`badge ${env.status}`}>{env.status}</span>
      </div>
      {env.expiresAt && (
        <p className="muted">
          {env.status === "expired" ? "Expired" : "Expires"} {new Date(env.expiresAt).toLocaleString()}
        </p>
      )}
      {notice && <div className="success">{notice}</div>}

      <div className="card">
        <h2>Recipients</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Order</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {env.recipients.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td><td>{r.email}</td><td>{r.role}</td><td>{r.routingOrder}</td>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td>
                  {canNudge(r) && (
                    <span className="row" style={{ gap: 6 }}>
                      <button className="btn ghost small" onClick={() => nudge(r.id, "remind")}>Remind</button>
                      <button className="btn ghost small" onClick={() => nudge(r.id, "resend")}>Resend link</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Documents</h2>
        <ul className="link-list">
          {env.documents.map((d) => (
            <li key={d.id}>
              📄 {d.name} <span className="muted">— {d.pageCount ?? "?"} page(s){d.signedBlobKey ? " · signed" : ""}</span>{" "}
              <button className="btn ghost small" onClick={() => download(d.id)}>Open</button>
            </li>
          ))}
        </ul>
      </div>

      {links.length > 0 && (
        <div className="card">
          <h2>Signer links (dev mode)</h2>
          <ul className="link-list">
            {links.map((l) => (
              <li key={l.recipientId}><strong>{l.name}</strong><br /><a href={l.link}>{l.link}</a></li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Audit trail</h2>
        <table>
          <thead><tr><th>#</th><th>Event</th><th>When</th><th>By</th></tr></thead>
          <tbody>
            {env.audit.map((a) => (
              <tr key={a.id}>
                <td className="muted">{a.seq}</td><td>{a.type}</td>
                <td className="muted">{new Date(a.at).toLocaleString()}</td><td className="muted">{a.actor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(env.status === "draft" || env.status === "sent") && (
        <button className="btn danger" onClick={doVoid}>Void envelope</button>
      )}
    </div>
  );
}
