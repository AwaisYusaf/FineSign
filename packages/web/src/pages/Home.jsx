import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listEnvelopes } from "../api.js";

const PAGE_SIZE = 50;

export default function Home() {
  const [envelopes, setEnvelopes] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setEnvelopes(null);
    listEnvelopes({ limit: PAGE_SIZE, offset }).then(setEnvelopes).catch((e) => setError(e.message));
  }, [offset]);

  // The server caps a page at its own limit, so a full page means there may be
  // more. Without this the list silently stopped at the cap.
  const hasMore = envelopes?.length === PAGE_SIZE;

  return (
    <div>
      <h1>Envelopes</h1>
      {error && <div className="error">{error} — check your sender API key.</div>}
      {!envelopes && !error && <p className="muted">Loading…</p>}
      {envelopes && envelopes.length === 0 && offset === 0 && (
        <div className="card">
          No envelopes yet. <Link to="/new">Create your first one →</Link>
        </div>
      )}
      {envelopes && envelopes.length === 0 && offset > 0 && (
        <div className="card">
          No more envelopes. <button className="btn ghost small" onClick={() => setOffset(0)}>Back to the start</button>
        </div>
      )}
      {envelopes && envelopes.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Recipients</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {envelopes.map((e) => (
                <tr key={e.id}>
                  <td><Link to={`/envelopes/${e.id}`}>{e.title}</Link></td>
                  <td><span className={`badge ${e.status}`}>{e.status}</span></td>
                  <td>{e.recipients.length}</td>
                  <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(offset > 0 || hasMore) && (
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button
                className="btn ghost small"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                ← Newer
              </button>
              <span className="muted small">{offset + 1}–{offset + envelopes.length}</span>
              <button className="btn ghost small" disabled={!hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Older →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
