import { useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import type { BackendState } from '../runtime/electron';

interface Props {
  backendState: BackendState;
  message: string;
  thinkingEnabled: boolean;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
  setThinking: (enabled: boolean) => Promise<void>;
  onClose: () => void;
}

const stateLabel: Record<BackendState, string> = {
  'waiting-for-key': 'DeepSeek API key not set',
  starting: 'Local service is starting…',
  ready: 'Local service is ready',
  error: 'The local service needs attention',
};

type Mutation = 'save' | 'clear' | 'thinking';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, input, a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.matches(':disabled'));
}

function focusInside(dialog: HTMLElement, reverse = false) {
  const focusable = focusableElements(dialog);
  (reverse ? focusable[focusable.length - 1] : focusable[0])?.focus();
  if (focusable.length === 0) dialog.focus();
}

export default function DeepSeekSettings({
  backendState,
  message,
  thinkingEnabled,
  saveKey,
  clearKey,
  setThinking,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mutationRef = useRef<Mutation | null>(null);
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const busy = mutation !== null;
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !dialog.contains(event.target)) {
        focusInside(dialog);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(dialog);
      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(active) || active === dialog) {
        event.preventDefault();
        focusInside(dialog, event.shiftKey);
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('keydown', handleKeyDown, true);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocus?.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (!dialog) return;
    if (
      !dialog.contains(active)
      || (active instanceof HTMLElement && active.matches(':disabled'))
    ) {
      focusInside(dialog);
    }
  }, [busy, confirmClear]);

  const beginMutation = (next: Mutation) => {
    if (mutationRef.current) return false;
    mutationRef.current = next;
    setMutation(next);
    return true;
  };

  const endMutation = (completed: Mutation) => {
    if (mutationRef.current !== completed) return;
    mutationRef.current = null;
    setMutation(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    let started = false;
    try {
      const key = input.value.trim();
      if (!key) {
        setError('Enter a new DeepSeek API key');
        return;
      }
      if (!beginMutation('save')) return;
      started = true;
      setError('');
      setNotice('');
      await saveKey(key);
      setNotice('Key updated securely. Restarting the local service.');
    } catch {
      setError('Couldn’t replace the DeepSeek API key. Check the key and your network, then try again.');
    } finally {
      input.value = '';
      if (started) endMutation('save');
    }
  };

  const handleClear = async () => {
    if (!beginMutation('clear')) return;
    setError('');
    setNotice('');
    try {
      await clearKey();
    } catch {
      setError('Couldn’t remove the API key. Please try again in a moment.');
      setConfirmClear(false);
    } finally {
      endMutation('clear');
    }
  };

  const handleThinking = async (enabled: boolean) => {
    if (!beginMutation('thinking')) return;
    setError('');
    try {
      await setThinking(enabled);
    } catch {
      setError('Couldn’t switch answer mode. Please try again in a moment.');
    } finally {
      endMutation('thinking');
    }
  };

  return (
    <div className="settings-backdrop">
      <section
        ref={dialogRef}
        className="deepseek-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deepseek-settings-title"
        aria-busy={busy}
        tabIndex={-1}
      >
        <div className="settings-heading">
          <h2 id="deepseek-settings-title">DeepSeek settings</h2>
          <button
            ref={closeButtonRef}
            className="settings-close"
            type="button"
            onClick={() => { if (!busyRef.current) onCloseRef.current(); }}
            aria-label="Close settings"
            disabled={busy}
          >✕</button>
        </div>

        <div className={`runtime-status runtime-${backendState}`} role="status">
          <strong>{stateLabel[backendState]}</strong>
          {message && <span>{message}</span>}
        </div>

        <fieldset className="thinking-options" disabled={busy}>
          <legend>Answer mode</legend>
          <label className="thinking-toggle">
            <input
              type="checkbox"
              aria-label="Deep thinking"
              checked={thinkingEnabled}
              onChange={event => { void handleThinking(event.target.checked); }}
            />
            <span>{thinkingEnabled ? 'Deep thinking' : 'Fast answers'}</span>
          </label>
          <p>Deep thinking uses more tokens. Use it for questions that need step-by-step reasoning.</p>
        </fieldset>

        <form className="replace-key-form" onSubmit={event => { void handleSave(event); }}>
          <label htmlFor="replacement-deepseek-key">New DeepSeek API key</label>
          <div className="settings-input-row">
            <input
              ref={inputRef}
              id="replacement-deepseek-key"
              name="replacement-deepseek-key"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
            />
            <button type="submit" disabled={busy}>
              {mutation === 'save' ? 'Replacing…' : 'Replace key securely'}
            </button>
          </div>
          <p className="settings-hint">The current key can’t be read or shown. Enter a new key to replace it securely.</p>
        </form>

        {error && <p className="setup-error" role="alert">{error}</p>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}

        <div className="clear-key-area">
          {!confirmClear ? (
            <button className="settings-danger" type="button" onClick={() => setConfirmClear(true)} disabled={busy}>
              Remove API key
            </button>
          ) : (
            <div className="clear-confirmation" role="group" aria-label="Confirm removing the API key">
              <p>You’ll go straight back to the first-time setup screen.</p>
              <div>
                <button type="button" onClick={() => setConfirmClear(false)} disabled={busy}>Cancel</button>
                <button className="settings-danger" type="button" onClick={() => { void handleClear(); }} disabled={busy}>
                  {mutation === 'clear' ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
