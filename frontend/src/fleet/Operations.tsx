import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from '../api';

const api = <T,>(path: string, body?: unknown, method?: string) =>
  request<T>(`/fleet/${path}`, body, undefined, method);
const stamp = (value: string) => new Date(value).toLocaleString();
const money = (value: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, run, feedback: error && <p role="alert">{error}</p> };
}

export function Inbox({ admin }: { admin: boolean }) {
  const notifications = useQuery({
    queryKey: ['operations-inbox'],
    queryFn: () =>
      api<
        {
          id: number;
          job_id: number;
          message: string;
          created: string;
          read: boolean;
        }[]
      >('notifications'),
    refetchInterval: 15000,
  });
  const action = useSave();
  const items = notifications.data ?? [];
  return (
    <details className="fleet-panel fleet-inbox">
      <summary>Notifications ({items.filter((item) => !item.read).length} unread)</summary>
      {notifications.isError && <p role="alert">Notifications are unavailable.</p>}
      {items.length > 0 ? (
        <>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api('notifications', {});
                await notifications.refetch();
              })
            }
          >
            Mark all read
          </button>
          <ul className="fleet-list">
            {items.map((item) => (
              <li key={item.id}>
                <a href={`/fleet${admin ? '/admin' : ''}/jobs/${item.job_id}`}>{item.message}</a>
                <small>
                  {stamp(item.created)}
                  {item.read ? '' : ' · Unread'}
                </small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>No notifications yet.</p>
      )}
      {action.feedback}
    </details>
  );
}

function Signature({
  canvas,
  signed,
}: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  signed: React.RefObject<boolean>;
}) {
  const drawing = useRef(false);
  return (
    <div>
      <canvas
        className="fleet-signature"
        width={520}
        height={150}
        ref={canvas}
        aria-label="Draw recipient signature"
        onPointerDown={(event) => {
          const element = event.currentTarget;
          element.setPointerCapture(event.pointerId);
          const context = element.getContext('2d');
          const bounds = element.getBoundingClientRect();
          context?.beginPath();
          context?.moveTo(
            ((event.clientX - bounds.left) * element.width) / bounds.width,
            ((event.clientY - bounds.top) * element.height) / bounds.height,
          );
          drawing.current = true;
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const element = event.currentTarget;
          const context = element.getContext('2d');
          const bounds = element.getBoundingClientRect();
          if (!context) return;
          context.strokeStyle = '#141414';
          context.lineWidth = 3;
          context.lineCap = 'round';
          context.lineTo(
            ((event.clientX - bounds.left) * element.width) / bounds.width,
            ((event.clientY - bounds.top) * element.height) / bounds.height,
          );
          context.stroke();
          signed.current = true;
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <button
        type="button"
        onClick={() => {
          canvas.current?.getContext('2d')?.clearRect(0, 0, 520, 150);
          signed.current = false;
        }}
      >
        Clear signature
      </button>
    </div>
  );
}

async function imageData(file: File) {
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const image = document.createElement('canvas');
    const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
    image.width = Math.max(1, Math.round(bitmap.width * scale));
    image.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = image.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(bitmap, 0, 0, image.width, image.height);
    return image.toDataURL('image/jpeg', 0.68).split(',')[1];
  } finally {
    bitmap.close();
  }
}

interface TripData {
  expenses: { id: number; category: string; amount: string; note: string }[];
  proof: { recipient: string; verified: string | null; photo: boolean; submitted: string } | null;
  location: { latitude: number; longitude: number; recorded: string } | null;
  estimated_eta: { arrival: string; late: boolean; basis: string } | null;
}

export function JobOperations({ id, status, admin }: { id: string; status: string; admin: boolean }) {
  const path = `jobs/${id}/operations`;
  const query = useQuery({
    queryKey: ['trip-operations', id],
    queryFn: () => api<TripData>(path),
    refetchInterval: 15000,
  });
  const action = useSave();
  const [consent, setConsent] = useState(false);
  const [receipt, setReceipt] = useState<{
    amount: string | null;
    merchant: string;
    date: string | null;
    currency: string;
  }>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const signed = useRef(false);
  const data = query.data;
  async function send(payload: object) {
    await api(path, payload);
    await query.refetch();
  }
  function submit(event: FormEvent<HTMLFormElement>, callback: (data: FormData) => Promise<void>) {
    event.preventDefault();
    const form = event.currentTarget;
    void action.run(async () => {
      await callback(new FormData(form));
      form.reset();
    });
  }
  return (
    <div className="fleet-grid">
      <section className="fleet-panel">
        <h2>Trip expenses</h2>
        <ul className="fleet-list">
          {data?.expenses.map((item) => (
            <li key={item.id}>
              <span>
                {item.category}
                {item.note && ` · ${item.note}`}
              </span>
              <strong>{money(item.amount)}</strong>
            </li>
          ))}
        </ul>
        {!admin && status !== 'cancelled' && (
          <form
            className="fleet-form"
            onSubmit={(event) =>
              submit(event, async (form) => {
                await send({ ...Object.fromEntries(form), action: 'expense' });
                setReceipt(undefined);
              })
            }
          >
            <div className="fleet-fields">
              <label>
                Category
                <select name="category">
                  <option value="fuel">Fuel</option>
                  <option value="toll">Toll</option>
                  <option value="parking">Parking</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Amount (USD)
                <input
                  key={receipt?.amount ?? 'manual'}
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  defaultValue={receipt?.currency === 'USD' ? (receipt.amount ?? undefined) : undefined}
                />
              </label>
            </div>
            <label>
              Note
              <input name="note" maxLength={250} />
            </label>
            <button className="fleet-primary" disabled={action.busy}>
              Log expense
            </button>
          </form>
        )}
        {!admin && status !== 'cancelled' && (
          <form
            className="fleet-form"
            onSubmit={(event) =>
              submit(event, async (form) => {
                const file = form.get('receipt');
                if (!(file instanceof File) || !file.size) return;
                setReceipt(await api(`jobs/${id}/receipt-extraction`, { photo: await imageData(file) }));
              })
            }
          >
            <label>
              Receipt image
              <input name="receipt" type="file" accept="image/*" required />
            </label>
            <button disabled={action.busy}>Extract receipt details</button>
            {receipt && (
              <p role="status">
                Review before saving:{' '}
                {[receipt.merchant, receipt.date, receipt.amount, receipt.currency]
                  .filter(Boolean)
                  .join(' · ') || 'No fields detected'}
              </p>
            )}
          </form>
        )}
      </section>
      <section className="fleet-panel">
        <h2>Location check-in</h2>
        {data?.location ? (
          <p>
            {Number(data.location.latitude).toFixed(5)}, {Number(data.location.longitude).toFixed(5)} ·{' '}
            {stamp(data.location.recorded)}
          </p>
        ) : (
          <p>No shared location.</p>
        )}
        {data?.estimated_eta && (
          <p>
            Estimated arrival {stamp(data.estimated_eta.arrival)} · {data.estimated_eta.basis}
            {data.estimated_eta.late && ' · After deadline'}
          </p>
        )}
        {!admin && ['en_route', 'delayed'].includes(status) && (
          <div className="fleet-form">
            <label className="fleet-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />{' '}
              Share my current position with dispatch for this check-in
            </label>
            <button
              disabled={!consent || action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (!navigator.geolocation) throw new Error('Location access is unavailable.');
                  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(
                      resolve,
                      () =>
                        reject(new Error('Could not get your position. Check browser location permissions.')),
                      { timeout: 10000 },
                    );
                  });
                  await send({
                    action: 'location',
                    consent: true,
                    latitude: position.coords.latitude.toFixed(5),
                    longitude: position.coords.longitude.toFixed(5),
                  });
                  setConsent(false);
                })
              }
            >
              Share location
            </button>
          </div>
        )}
        {!admin && data?.location && (
          <button
            disabled={action.busy}
            onClick={() => void action.run(() => send({ action: 'clear_location' }))}
          >
            Remove shared location
          </button>
        )}
      </section>
      {status === 'delivered' && (
        <section className="fleet-panel">
          <h2>Proof of delivery</h2>
          {data?.proof && (
            <div className="fleet-form">
              <p>
                {data.proof.recipient} ·{' '}
                {data.proof.verified ? `Verified ${stamp(data.proof.verified)}` : 'Awaiting verification'}
              </p>
              <a href={`/api/fleet/jobs/${id}/proof/signature`}>View signature</a>
              {data.proof.photo && <a href={`/api/fleet/jobs/${id}/proof/photo`}>View delivery photo</a>}
              {admin && !data.proof.verified && (
                <button
                  disabled={action.busy}
                  onClick={() => void action.run(() => send({ action: 'verify' }))}
                >
                  Verify proof
                </button>
              )}
            </div>
          )}
          {!admin && !data?.proof?.verified && (
            <form
              className="fleet-form"
              onSubmit={(event) =>
                submit(event, async (form) => {
                  if (!signed.current) throw new Error('Capture the recipient signature.');
                  const photo = form.get('photo');
                  await send({
                    action: 'proof',
                    recipient: form.get('recipient'),
                    signature: canvas.current!.toDataURL().split(',')[1],
                    ...(photo instanceof File && photo.size ? { photo: await imageData(photo) } : {}),
                  });
                  canvas.current?.getContext('2d')?.clearRect(0, 0, 520, 150);
                  signed.current = false;
                })
              }
            >
              <label>
                Recipient name
                <input name="recipient" maxLength={120} required />
              </label>
              <p>Recipient signature</p>
              <Signature canvas={canvas} signed={signed} />
              <label>
                Delivery photo (optional)
                <input name="photo" type="file" accept="image/*" />
              </label>
              <button className="fleet-primary" disabled={action.busy}>
                Submit proof
              </button>
            </form>
          )}
        </section>
      )}
      {query.isError && <p role="alert">Trip operations are unavailable.</p>}
      {action.feedback}
    </div>
  );
}

export function VehicleRecords({ id }: { id: number }) {
  const path = `trucks/${id}/records`;
  const records = useQuery({
    queryKey: ['vehicle-records', id],
    queryFn: () =>
      api<
        {
          id: number;
          kind: string;
          title: string;
          due: string;
          completed: string | null;
        }[]
      >(path),
  });
  const action = useSave();
  return (
    <details className="fleet-vehicle-records">
      <summary>Maintenance and documents</summary>
      <ul className="fleet-list">
        {records.data?.map((item) => (
          <li key={item.id}>
            <span>
              {item.title} · {item.kind} ·{' '}
              {item.completed ? `Completed ${item.completed}` : `Due ${item.due}`}
            </span>
            {!item.completed && (
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api(path, { id: item.id }, 'PATCH');
                    await records.refetch();
                  })
                }
              >
                Mark complete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="fleet-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = Object.fromEntries(new FormData(form));
          void action.run(async () => {
            await api(path, values);
            form.reset();
            await records.refetch();
          });
        }}
      >
        <label>
          Record type
          <select name="kind">
            {['maintenance', 'insurance', 'permit', 'registration', 'other'].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input name="title" required maxLength={120} />
        </label>
        <label>
          Due date
          <input name="due" type="date" required />
        </label>
        <button disabled={action.busy}>Add record</button>
      </form>
      {action.feedback}
    </details>
  );
}

interface InsightData {
  late_jobs: number[];
  weather_jobs: number[];
  due_records: { title: string; due: string; truck__registration: string }[];
  suggestions: { job: number; driver: string; truck: string; capacity: number }[];
}

export function Reports() {
  const insights = useQuery({
    queryKey: ['dispatch-insights'],
    queryFn: () => api<InsightData>('insights'),
    refetchInterval: 30000,
  });
  const report = useQuery({
    queryKey: ['operations-report'],
    queryFn: () =>
      api<
        {
          id: number;
          pickup: string;
          delivery: string;
          status: string;
          cost: string;
        }[]
      >('reports'),
  });
  const links = (ids: number[]): ReactNode =>
    ids.length
      ? ids.map((id) => (
          <a key={id} href={`/fleet/admin/jobs/${id}`}>
            Job #{id}{' '}
          </a>
        ))
      : 'None';
  const data = insights.data;
  const assistant = useSave();
  const [answer, setAnswer] = useState<{
    title: string;
    rows: (number | InsightData['due_records'][number] | InsightData['suggestions'][number])[];
  }>();
  return (
    <div className="fleet-grid">
      <section className="fleet-panel">
        <h2>Dispatch insights</h2>
        {data && (
          <>
            <p>Late or at risk: {links(data.late_jobs)}</p>
            <p>Severe weather on saved routes: {links(data.weather_jobs)}</p>
            <h3>Maintenance and documents due within seven days</h3>
            <ul className="fleet-list">
              {data.due_records.map((row, index) => (
                <li key={index}>
                  {row.truck__registration} · {row.title} · {row.due}
                </li>
              ))}
            </ul>
            <h3>Suggested assignments</h3>
            <ul className="fleet-list">
              {data.suggestions.map((row) => (
                <li key={row.job}>
                  {links([row.job])}
                  <span>
                    {row.driver} · {row.truck} · {row.capacity.toLocaleString()} lb
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {insights.isError && <p role="alert">Dispatch insights are unavailable.</p>}
      </section>
      <section className="fleet-panel">
        <h2>Fleet assistant</h2>
        <form
          className="fleet-form"
          onSubmit={(event) => {
            event.preventDefault();
            const question = new FormData(event.currentTarget).get('question');
            setAnswer(undefined);
            void assistant.run(async () => setAnswer(await api('assistant', { question })));
          }}
        >
          <label>
            Question
            <input name="question" required maxLength={400} placeholder="Which jobs are likely to be late?" />
          </label>
          <button disabled={assistant.busy}>Ask</button>
        </form>
        {answer && (
          <div role="status">
            <strong>{answer.title}</strong>
            {answer.rows.length === 0 ? (
              <p>No matching records.</p>
            ) : (
              <ul className="fleet-list">
                {answer.rows.map((row, index) => (
                  <li key={index}>
                    {typeof row === 'number' ? (
                      links([row])
                    ) : 'job' in row ? (
                      <>
                        {links([row.job])}
                        <span>
                          {row.driver} · {row.truck}
                        </span>
                      </>
                    ) : (
                      <span>
                        {row.truck__registration} · {row.title} · {row.due}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {assistant.feedback}
      </section>
      <section className="fleet-panel">
        <h2>Delivery costs</h2>
        <a href="/api/fleet/reports?download=csv">Download CSV</a>
        <ul className="fleet-list">
          {report.data?.map((item) => (
            <li key={item.id}>
              <a href={`/fleet/admin/jobs/${item.id}`}>
                {item.pickup} → {item.delivery}
              </a>
              <span>{money(item.cost)}</span>
            </li>
          ))}
        </ul>
        {report.isError && <p role="alert">Delivery costs are unavailable.</p>}
      </section>
    </div>
  );
}
