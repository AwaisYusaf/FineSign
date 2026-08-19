import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listEnvelopes } from "../api.js";

export default function Home() {
  const [envelopes, setEnvelopes] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    listEnvelopes().then(setEnvelopes).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h1>Envelopes</h1>
      {error && <div className="error">{error} — check your sender API key.</div>}
      {!envelopes && !error && <p className="muted">Loading…</p>}
      {envelopes && envelopes.length === 0 && (
        <div className="card">
          No envelopes yet. <Link to="/new">Create your first one →</Link>
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
        </div>
      )}
    </div>
  );
}
