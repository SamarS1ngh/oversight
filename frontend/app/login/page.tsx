"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username, password)
          : await api.signup(username, password);
      setToken(res.token);
      router.replace("/dashboard");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>VMS {mode === "login" ? "Login" : "Sign up"}</h1>
        <input
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
        <p className="muted switch">
          {mode === "login" ? "No account?" : "Have an account?"}{" "}
          <a
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setErr(null);
            }}
          >
            {mode === "login" ? "Sign up" : "Log in"}
          </a>
        </p>
        <p className="hint">demo login: demo / demo12345</p>
      </form>
    </main>
  );
}
