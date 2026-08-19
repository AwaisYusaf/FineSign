import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getSession, authenticateSession, applySignature, declineSession, signerDocUrl } from "../api.js";
import PdfView from "../components/PdfView.jsx";
import SignaturePad from "../components/SignaturePad.jsx";

export default function Sign() {
  const { token } = useParams();
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [signature, setSignature] = useState(null);
  const [fieldValues, setFieldValues] = useState({}); // fieldId -> string ("true"/"false" for checkbox)
  const [consented, setConsented] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { status } | { declined: true }

  useEffect(() => {
    getSession(token).then(setSession).catch((e) => setError(e.message));
  }, [token]);

  async function submitAccessCode(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authenticateSession(token, accessCode);
      setSession(await getSession(token)); // re-fetch — now unlocked
    } catch (err) {
      setError(err.status === 403 ? "That access code is incorrect." : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function signAll() {
    setBusy(true);
    setError(null);
    try {
      const values = Object.entries(fieldValues).map(([fieldId, value]) => ({ fieldId, value }));
      const r = await applySignature(token, signature, consented, values);
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    const reason = window.prompt("Reason for declining?");
    if (reason == null) return;
    setBusy(true);
    try {
      await declineSession(token, reason);
      setResult({ declined: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !session) {
    return (
      <div className="card narrow">
        <h2>Signing link unavailable</h2>
        <p className="muted">{error}</p>
        <p className="muted">This link may be invalid, expired, or already used.</p>
      </div>
    );
  }
  if (!session && !error) return <p className="muted">Loading your documents…</p>;

  if (result) {
    return (
      <div className="card narrow">
        {result.declined ? (
          <>
            <h2>Declined</h2>
            <p className="muted">You declined to sign. The sender has been notified.</p>
          </>
        ) : result.status === "completed" ? (
          <>
            <h2>✅ All done</h2>
            <p className="muted">Thanks, {session.recipient.name}. Everyone has signed and the agreement is complete.</p>
          </>
        ) : (
          <>
            <h2>✅ Signature recorded</h2>
            <p className="muted">Thanks, {session.recipient.name}. Your signature is recorded; we&apos;re now waiting on the other signers.</p>
          </>
        )}
      </div>
    );
  }

  // Access-code gate: the documents are not revealed until the code is accepted.
  if (session.authRequired && !session.authenticated) {
    return (
      <form className="card narrow" onSubmit={submitAccessCode}>
        <h2>Enter your access code</h2>
        <p className="muted">The sender protected this document with an access code. Enter it to continue.</p>
        {error && <div className="error">{error}</div>}
        <input
          className="input"
          type="text"
          autoComplete="one-time-code"
          value={accessCode}
          onChange={(e) => setAccessCode(e.target.value)}
          placeholder="Access code"
          style={{ marginTop: 12 }}
        />
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={busy || !accessCode.trim()}>Continue</button>
        </div>
      </form>
    );
  }

  const kindLabel = (k) => (k === "date_signed" ? "date" : k);

  const setFieldValue = (id, v) => setFieldValues((prev) => ({ ...prev, [id]: v }));

  function fieldsOverlay(documentId) {
    return (page) =>
      session.documents.find((d) => d.id === documentId).fields
        .filter((f) => f.page === page)
        .map((f) => {
          const box = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
          if (f.kind === "text") {
            return (
              <input
                key={f.id}
                className="field-box field-input"
                style={box}
                value={fieldValues[f.id] ?? ""}
                onChange={(e) => setFieldValue(f.id, e.target.value)}
                placeholder="text"
              />
            );
          }
          if (f.kind === "checkbox") {
            return (
              <div key={f.id} className="field-box field-check" style={box}>
                <input
                  type="checkbox"
                  checked={fieldValues[f.id] === "true"}
                  onChange={(e) => setFieldValue(f.id, e.target.checked ? "true" : "false")}
                />
              </div>
            );
          }
          return (
            <div key={f.id} className={`field-box${f.kind === "date_signed" ? " date" : ""}`} style={box}>
              {kindLabel(f.kind)}
            </div>
          );
        });
  }

  return (
    <div>
      <h1>{session.title}</h1>
      <p className="muted">Hi {session.recipient.name} — please review and sign the highlighted fields below.</p>
      {error && <div className="error">{error}</div>}

      {session.documents.map((d) => (
        <div className="card" key={d.id}>
          <h3>{d.name}</h3>
          <PdfView
            key={d.id}
            loadBytes={() => fetch(signerDocUrl(token, d.id)).then((r) => {
              if (!r.ok) throw new Error("Could not load document");
              return r.arrayBuffer();
            })}
            renderOverlay={fieldsOverlay(d.id)}
          />
        </div>
      ))}

      <div className="card">
        <h2>Your signature</h2>
        <SignaturePad onChange={setSignature} />
        {session.consent && (
          <label className="row" style={{ marginTop: 14, alignItems: "flex-start", gap: 10 }}>
            <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} style={{ marginTop: 4 }} />
            <span className="muted small">{session.consent.disclosure}</span>
          </label>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={busy || !signature || !consented} onClick={signAll}>Sign all fields</button>
          <button className="btn ghost" disabled={busy} onClick={decline}>Decline</button>
        </div>
        {!signature && <p className="muted small" style={{ marginTop: 8 }}>Draw or type your signature to enable signing.</p>}
        {signature && !consented && <p className="muted small" style={{ marginTop: 8 }}>Check the consent box above to enable signing.</p>}
      </div>
    </div>
  );
}
