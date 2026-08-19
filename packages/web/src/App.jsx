import { Routes, Route, Link, useLocation } from "react-router-dom";
import ApiKeyGate from "./components/ApiKeyGate.jsx";
import Home from "./pages/Home.jsx";
import Create from "./pages/Create.jsx";
import EnvelopeDetail from "./pages/EnvelopeDetail.jsx";
import Webhooks from "./pages/Webhooks.jsx";
import Sign from "./pages/Sign.jsx";

export default function App() {
  const location = useLocation();
  const isSigner = location.pathname.startsWith("/s/");

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">✒️ FineSign</Link>
        {!isSigner && (
          <nav>
            <Link to="/">Envelopes</Link>
            <Link to="/webhooks">Webhooks</Link>
            <Link to="/new" className="btn small">New envelope</Link>
          </nav>
        )}
      </header>
      <main className="container">
        <Routes>
          <Route path="/" element={<ApiKeyGate><Home /></ApiKeyGate>} />
          <Route path="/new" element={<ApiKeyGate><Create /></ApiKeyGate>} />
          <Route path="/envelopes/:id" element={<ApiKeyGate><EnvelopeDetail /></ApiKeyGate>} />
          <Route path="/webhooks" element={<ApiKeyGate><Webhooks /></ApiKeyGate>} />
          <Route path="/s/:token" element={<Sign />} />
          <Route path="*" element={<div className="card">Page not found.</div>} />
        </Routes>
      </main>
    </div>
  );
}
