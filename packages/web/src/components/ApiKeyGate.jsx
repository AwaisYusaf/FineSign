import { useState } from "react";
import { getApiKey, setApiKey } from "../config.js";

/** Wraps management pages: prompts for the sender API key until one is set. */
export default function ApiKeyGate({ children }) {
  const [key, setKey] = useState(getApiKey());
  const [value, setValue] = useState("");

  if (key) {
    return (
      <div>
        <div className="apikey-bar">
          <span className="muted">Sender API key set.</span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              setApiKey("");
              setKey("");
            }}
          >
            Change key
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="card narrow">
      <h2>Sender access</h2>
      <p className="muted">
        The management console is protected by a sender API key (the server&apos;s{" "}
        <code>FINESIGN_SENDER_API_KEY</code>). Enter it to continue.
      </p>
      <input
        className="input"
        type="password"
        placeholder="Sender API key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        className="btn"
        disabled={!value}
        onClick={() => {
          setApiKey(value);
          setKey(value);
        }}
      >
        Continue
      </button>
    </div>
  );
}
