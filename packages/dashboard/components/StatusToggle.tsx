'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const statuses = ['active', 'unverified', 'likely_expired', 'expired', 'flagged'] as const;

export function StatusToggle({ id, currentStatus }: { id: number; currentStatus: string }) {
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState(currentStatus);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    setStatus(currentStatus);
  }, [currentStatus]);

  return (
    <details className="min-w-56">
      <summary className="cursor-pointer text-sm text-sky-300">Change status</summary>
      <form
        className="mt-2 flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            setMessage('');
            const response = await fetch(`/api/promos/${id}/status`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ status, adminSecret: secret })
            });
            if (response.ok) {
              setMessage('Saved');
              router.refresh();
            } else {
              setMessage(response.status === 401 ? 'Invalid admin secret' : 'Save failed');
            }
          });
        }}
      >
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="Admin secret"
          autoComplete="off"
        />
        <button type="submit" disabled={pending || !secret}>{pending ? 'Saving…' : 'Save status'}</button>
        {message ? <span className="text-xs text-slate-300">{message}</span> : null}
      </form>
    </details>
  );
}
