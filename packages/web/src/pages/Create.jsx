import { useState } from "react";
import { Link } from "react-router-dom";
import {
  createEnvelope, addDocument, addRecipient, addField, removeField, sendEnvelope,
  getDevLinks, managementDocUrl,
} from "../api.js";
import { getApiKey, FIELD_KINDS } from "../config.js";
import PdfView from "../components/PdfView.jsx";

const STEPS = ["Details", "Documents", "Recipients", "Place fields", "Send"];
// Default drop size per field kind, as fractions of the displayed page.
const DEFAULT_SIZE = {
  signature: { w: 0.24, h: 0.045 },
  initials: { w: 0.12, h: 0.045 },
  date_signed: { w: 0.16, h: 0.03 },
  text: { w: 0.24, h: 0.03 },
  checkbox: { w: 0.03, h: 0.022 },
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Create() {
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // step 0
  const [title, setTitle] = useState("");
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [routingType, setRoutingType] = useState("sequential");
  // step 2
  const [rName, setRName] = useState("");
  const [rEmail, setREmail] = useState("");
  const [rRole, setRRole] = useState("signer");
  const [rOrder, setROrder] = useState(1);
  const [rAccessCode, setRAccessCode] = useState("");
  // step 3
  const [activeDoc, setActiveDoc] = useState(null);
  const [activeRecipient, setActiveRecipient] = useState("");
  const [activeKind, setActiveKind] = useState("signature");
  // step 4
  const [devLinks, setDevLinks] = useState(null);
  const [expiresInDays, setExpiresInDays] = useState("");

  async function guard(fn) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const createDraft = () =>
    guard(async () => {
      const e = await createEnvelope({ title, senderName, senderEmail, routingType });
      setEnv(e);
      setStep(1);
    });

  const uploadFile = (file) =>
    guard(async () => {
      const format = file.name.toLowerCase().endsWith(".docx") ? "docx" : "pdf";
      const contentBase64 = await fileToBase64(file);
      const e = await addDocument(env.id, { name: file.name, format, contentBase64 });
      setEnv(e);
      if (!activeDoc) setActiveDoc(e.documents[e.documents.length - 1].id);
    });

  const addRec = () =>
    guard(async () => {
      const code = rAccessCode.trim();
      const e = await addRecipient(env.id, {
        name: rName,
        email: rEmail,
        role: rRole,
        routingOrder: Number(rOrder),
        ...(code ? { authMethod: "access_code", accessCode: code } : {}),
      });
      setEnv(e);
      setRName(""); setREmail(""); setRAccessCode(""); setROrder(Number(rOrder) + 1);
      if (!activeRecipient) setActiveRecipient(e.recipients[e.recipients.length - 1].id);
    });

  const dropField = (documentId, page, frac) =>
    guard(async () => {
      if (!activeRecipient) throw new Error("Pick a recipient to assign the field to first.");
      const d = DEFAULT_SIZE[activeKind];
      const width = Math.min(d.w, 1 - frac.x);
      const height = Math.min(d.h, 1 - frac.y);
      const e = await addField(env.id, {
        documentId, recipientId: activeRecipient, page,
        x: frac.x, y: frac.y, width, height, kind: activeKind,
      });
      setEnv(e);
    });

  const deleteField = (fieldId) =>
    guard(async () => {
      setEnv(await removeField(env.id, fieldId));
    });

  const doSend = () =>
    guard(async () => {
      const days = expiresInDays.trim() === "" ? undefined : Number(expiresInDays);
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
        throw new Error("Expiration must be a positive number of days (or blank for none).");
      }
      const e = await sendEnvelope(env.id, days);
      setEnv(e);
      const { links } = await getDevLinks(env.id);
      setDevLinks(links);
      setStep(4);
    });

  const recipientColor = (recipientId) => {
    const idx = env.recipients.findIndex((r) => r.id === recipientId);
    const hues = [220, 150, 280, 30, 340];
    return `hsl(${hues[idx % hues.length]}, 70%, 45%)`;
  };

  function fieldsOverlay(documentId) {
    return (page) =>
      env.fields
        .filter((f) => f.documentId === documentId && f.page === page)
        .map((f) => (
          <button
            type="button"
            key={f.id}
            className={`field-box placed${f.kind === "date_signed" ? " date" : ""}`}
            title={`${f.kind} — ${env.recipients.find((r) => r.id === f.recipientId)?.name ?? ""} · click to remove`}
            style={{
              left: `${f.x * 100}%`, top: `${f.y * 100}%`,
              width: `${f.width * 100}%`, height: `${f.height * 100}%`,
              borderColor: recipientColor(f.recipientId),
            }}
            // The page is the drop target, so removing a field must not also drop
            // a fresh one where the click landed.
            onClick={(e) => { e.stopPropagation(); deleteField(f.id); }}
          >
            <span className="field-label">{f.kind === "date_signed" ? "date" : f.kind}</span>
            <span className="field-remove" aria-hidden="true">×</span>
          </button>
        ));
  }

  const docLoader = (documentId) => () =>
    fetch(managementDocUrl(env.id, documentId), { headers: { authorization: `Bearer ${getApiKey()}` } }).then((r) => {
      if (!r.ok) throw new Error("Could not load document");
      return r.arrayBuffer();
    });

  return (
    <div>
      <h1>New envelope</h1>
      <div className="steps">
        {STEPS.map((s, i) => (
          <span key={s} className={`step${i === step ? " active" : i < step ? " done" : ""}`}>{i + 1}. {s}</span>
        ))}
      </div>
      {error && <div className="error">{error}</div>}

      {step === 0 && (
        <div className="card">
          <label className="field"><span>Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Master Services Agreement" />
          </label>
          <div className="grid2">
            <label className="field"><span>Your name</span>
              <input className="input" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
            </label>
            <label className="field"><span>Your email</span>
              <input className="input" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
            </label>
          </div>
          <label className="field"><span>Signing order</span>
            <select className="input" value={routingType} onChange={(e) => setRoutingType(e.target.value)}>
              <option value="sequential">Sequential (one after another)</option>
              <option value="parallel">Parallel (all at once)</option>
            </select>
          </label>
          <button className="btn" disabled={busy || !title || !senderName || !senderEmail} onClick={createDraft}>Create draft</button>
        </div>
      )}

      {step === 1 && env && (
        <div className="card">
          <h2>Documents</h2>
          <p className="muted">Upload one or more PDF or Word (.docx) files. Word files are converted to PDF on the server.</p>
          <input type="file" accept=".pdf,.docx" disabled={busy}
            onChange={(e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); e.target.value = ""; }} />
          <ul className="link-list" style={{ marginTop: 12 }}>
            {env.documents.map((d) => (
              <li key={d.id}>📄 {d.name} <span className="muted">— {d.pageCount ?? "?"} page(s)</span></li>
            ))}
          </ul>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
            <button className="btn" disabled={env.documents.length === 0} onClick={() => setStep(2)}>Next</button>
          </div>
        </div>
      )}

      {step === 2 && env && (
        <div className="card">
          <h2>Recipients</h2>
          <div className="toolbar">
            <label className="field"><span>Name</span><input className="input" value={rName} onChange={(e) => setRName(e.target.value)} /></label>
            <label className="field"><span>Email</span><input className="input" value={rEmail} onChange={(e) => setREmail(e.target.value)} /></label>
            <label className="field"><span>Role</span>
              <select className="input" value={rRole} onChange={(e) => setRRole(e.target.value)}>
                <option value="signer">Signer</option>
                <option value="approver">Approver</option>
                <option value="cc">CC</option>
              </select>
            </label>
            <label className="field"><span>Order</span><input className="input" type="number" min="1" style={{ width: 70 }} value={rOrder} onChange={(e) => setROrder(e.target.value)} /></label>
            <label className="field"><span>Access code (optional)</span><input className="input" value={rAccessCode} onChange={(e) => setRAccessCode(e.target.value)} placeholder="shared secret" /></label>
            <button className="btn" disabled={busy || !rName || !rEmail} onClick={addRec}>Add</button>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Order</th><th>Auth</th></tr></thead>
            <tbody>
              {env.recipients.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td>{r.email}</td><td>{r.role}</td><td>{r.routingOrder}</td><td>{r.authMethod === "access_code" ? "🔒 code" : "—"}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn" disabled={env.recipients.length === 0} onClick={() => setStep(3)}>Next</button>
          </div>
        </div>
      )}

      {step === 3 && env && (
        <div className="card">
          <h2>Place fields</h2>
          <p className="muted">Pick a recipient and field type, then click on the document to drop a field. Click a placed field to remove it.</p>
          <div className="toolbar">
            <label className="field"><span>Document</span>
              <select className="input" value={activeDoc ?? ""} onChange={(e) => setActiveDoc(e.target.value)}>
                {env.documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Assign to</span>
              <select className="input" value={activeRecipient} onChange={(e) => setActiveRecipient(e.target.value)}>
                {env.recipients.filter((r) => r.role !== "cc").map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Field</span>
              <select className="input" value={activeKind} onChange={(e) => setActiveKind(e.target.value)}>
                {FIELD_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
          </div>
          {activeDoc && (
            <PdfView
              key={activeDoc}
              loadBytes={docLoader(activeDoc)}
              onPageClick={(page, frac) => dropField(activeDoc, page, frac)}
              renderOverlay={fieldsOverlay(activeDoc)}
            />
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
            <button className="btn" onClick={() => setStep(4)} disabled={env.fields.length === 0}>Review &amp; send</button>
          </div>
        </div>
      )}

      {step === 4 && env && (
        <div className="card">
          <h2>Send</h2>
          {!devLinks ? (
            <>
              <p>Ready to send <strong>{env.title}</strong> to {env.recipients.length} recipient(s) with {env.fields.length} field(s).</p>
              <label className="field" style={{ maxWidth: 260 }}>
                <span>Expires after (days)</span>
                <input
                  type="number"
                  min="1"
                  placeholder="No expiration"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                />
                <small className="muted">Leave blank for no deadline. After this, unsigned recipients can no longer sign.</small>
              </label>
              <div className="row">
                <button className="btn ghost" onClick={() => setStep(3)}>Back</button>
                <button className="btn" disabled={busy} onClick={doSend}>Send envelope</button>
              </div>
            </>
          ) : (
            <>
              <div className="success">Sent! Status: <strong>{env.status}</strong>.</div>
              {devLinks.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 16 }}>Signer links (dev mode)</h3>
                  <p className="muted">These are shown because the server has <code>FINESIGN_DEV_EXPOSE_TOKENS=true</code>. In production, signers receive them by email.</p>
                  <ul className="link-list">
                    {devLinks.map((l) => (
                      <li key={l.recipientId}><strong>{l.name}</strong> &lt;{l.email}&gt;<br /><a href={l.link}>{l.link}</a></li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">Signers have been emailed their signing links.</p>
              )}
              <Link className="btn" to={`/envelopes/${env.id}`} style={{ marginTop: 12 }}>View envelope</Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
