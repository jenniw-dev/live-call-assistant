import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

interface Props {
  save: (key: string) => Promise<void>;
  clearingPreviousKey?: boolean;
}

export default function ApiKeySetup({ save, clearingPreviousKey = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    let started = false;
    try {
      if (clearingPreviousKey) return;
      const key = input.value.trim();
      if (!key) {
        setError('Enter your DeepSeek API key');
        return;
      }
      if (savingRef.current) return;
      savingRef.current = true;
      started = true;
      setError('');
      setSaving(true);
      await save(key);
    } catch {
      setError('Couldn’t save the key or start DeepSeek. Check the key and your network, then try again.');
    } finally {
      input.value = '';
      if (started) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <main className="startup-screen setup-screen">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-logo" aria-hidden="true">🎯</div>
        <h1 id="setup-title">Set up DeepSeek</h1>
        <p>Before you start, paste your DeepSeek API key.</p>
        <form onSubmit={event => { void handleSubmit(event); }}>
          <label htmlFor="deepseek-api-key">DeepSeek API Key</label>
          <input
            ref={inputRef}
            id="deepseek-api-key"
            name="deepseek-api-key"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={clearingPreviousKey ? 'key-clear-pending' : undefined}
            disabled={saving || clearingPreviousKey}
          />
          {clearingPreviousKey && (
            <p id="key-clear-pending" className="settings-notice" role="status">
              Finishing removal of the old key, please wait…
            </p>
          )}
          {error && <p className="setup-error" role="alert">{error}</p>}
          <button className="setup-primary" type="submit" disabled={saving || clearingPreviousKey}>
            {clearingPreviousKey ? 'Finishing removal…' : saving ? 'Saving securely…' : 'Save securely and start'}
          </button>
        </form>
        <div className="setup-notes">
          <p>🔒 The key is encrypted and stored only on this Mac. It never goes into project files or chat logs.</p>
          <p>💳 DeepSeek charges your account for the input and output tokens you actually use.</p>
        </div>
      </section>
    </main>
  );
}
