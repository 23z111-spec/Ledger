// New file: place at src/ForgotPassword.jsx
// Import into App.jsx: import ForgotPassword from "./ForgotPassword";

import { useState } from "react";

export default function ForgotPassword({ api, initialUsername = "", onClose, onResetSuccess }) {
  const [step, setStep] = useState("username"); // "username" | "answer"
  const [username, setUsername] = useState(initialUsername);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitUsername(event) {
    event.preventDefault();
    if (!username.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.getSecurityQuestion(username.trim());
      setQuestion(result.security_question);
      setStep("answer");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event) {
    event.preventDefault();
    if (!answer.trim() || !newPassword || busy) return;
    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.resetPassword(username.trim(), answer.trim(), newPassword);
      onResetSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>

        {step === "username" ? (
          <>
            <h2>Reset your password</h2>
            <p className="muted">Enter your username to see your security question.</p>
            <form onSubmit={submitUsername}>
              <label className="field-label" htmlFor="reset-username">Username</label>
              <div className="input-shell">
                <input
                  id="reset-username"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="e.g. priya"
                  autoComplete="username"
                />
              </div>
              {error && <p className="error-text">{error}</p>}
              <button className="primary-button full-button" type="submit" disabled={busy}>
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h2>Answer your security question</h2>
            <p className="muted security-question-text">{question}</p>
            <form onSubmit={submitReset}>
              <label className="field-label" htmlFor="answer">Your answer</label>
              <div className="input-shell">
                <input
                  id="answer"
                  type="text"
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="Your answer"
                  autoComplete="off"
                />
              </div>

              <label className="field-label" htmlFor="new-password">New password</label>
              <div className="input-shell">
                <input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>

              {error && <p className="error-text">{error}</p>}
              <button className="primary-button full-button" type="submit" disabled={busy}>
                {busy ? "Resetting…" : "Reset password"}
              </button>
              <button
                type="button"
                className="text-button-inline"
                onClick={() => { setStep("username"); setError(""); }}
              >
                Use a different username
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}