import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import App from '../App';
import { request } from '../api';
import { PlaceInput } from '../components/PlaceInput';
import type { Place } from '../types';
import './fleet.css';

interface User {
  id: number;
  username: string;
  role: 'admin' | 'driver';
  company: string;
}

interface Driver {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

interface Job {
  id: number;
  driver_id: number;
  driver_name: string;
  origin: Place;
  destination: Place;
  departure: string;
  deadline: string;
  load_weight_lb: number;
  status: string;
  risk: string;
  eta: string | null;
  eta_updated_at: string | null;
  updated_at: string;
  delivered_at: string | null;
  route: { label: string } | null;
  history?: { status: string; eta: string | null; note: string; created_at: string }[];
}

const fleet = <T,>(path: string, data?: unknown, method?: string) =>
  request<T>(`/fleet/${path}`, data, undefined, method);
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
const label = (value: string) => value.replaceAll('_', ' ');
const closed = (job: Job) => ['cancelled', 'delivered'].includes(job.status);
const title = (job: Job) => `${job.origin.label} → ${job.destination.label}`;
const priority: Record<string, number> = {
  overdue: 0,
  at_risk: 1,
  stale_eta: 2,
  missing_eta: 3,
  on_track: 4,
};

function localInput(value: string | number) {
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, run };
}

function Layout({ user, children }: { user?: User; children: ReactNode }) {
  const action = useAction();
  return (
    <div className="fleet-shell">
      <header className="fleet-header">
        <a className="brand" href="/fleet">
          TruckMate<span className="brand-period">.</span>
        </a>
        <nav aria-label="Fleet navigation">
          <a href="/">Route planner</a>
          {user && (
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await fleet('logout', {});
                  location.replace('/fleet');
                })
              }
            >
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main className="fleet-main">
        {action.message && <p role="alert">{action.message}</p>}
        {children}
      </main>
    </div>
  );
}

function Account({ reset, emailEnabled }: { reset: boolean; emailEnabled: boolean }) {
  const [recovery, setRecovery] = useState(false);
  const [sent, setSent] = useState(false);
  const action = useAction();
  const params = new URLSearchParams(location.hash.slice(1));
  const client = useQueryClient();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    void action.run(async () => {
      if (reset) {
        await fleet('password/reset', { ...data, user: params.get('user'), token: params.get('token') });
        location.replace('/fleet');
      } else if (recovery) {
        await fleet('password/request', data);
        setSent(true);
      } else {
        const result = await fleet<{ user: User }>('login', data);
        client.setQueryData(['fleet-session'], { ...result, email_enabled: emailEnabled });
      }
    });
  }
  return (
    <Layout>
      <section className="fleet-panel fleet-account">
        <h1>{reset ? 'Set your password' : recovery ? 'Reset your password' : 'Fleet sign-in'}</h1>
        {sent ? (
          <p role="status">If the account exists, we’ll send a password reset link.</p>
        ) : (
          <form className="fleet-form" onSubmit={submit}>
            {!reset && (
              <label>
                Email
                <input name="username" type="email" autoComplete="username" required />
              </label>
            )}
            {!recovery && (
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  required
                  autoComplete={reset ? 'new-password' : 'current-password'}
                />
              </label>
            )}
            <button className="fleet-primary" disabled={action.busy}>
              {reset ? 'Save password' : recovery ? 'Send reset link' : 'Sign in'}
            </button>
          </form>
        )}
        {action.message && <p role="alert">{action.message}</p>}
        {reset ? (
          <a href="/fleet">Back to sign-in</a>
        ) : emailEnabled ? (
          <button
            className="fleet-text-button"
            onClick={() => {
              setRecovery(!recovery);
              setSent(false);
            }}
          >
            {recovery ? 'Back to sign-in' : 'Forgot your password?'}
          </button>
        ) : (
          <p>For a password reset, contact your fleet administrator.</p>
        )}
      </section>
    </Layout>
  );
}

function JobForm({ drivers, job, saved }: { drivers: Driver[]; job?: Job; saved: () => void }) {
  const action = useAction();
  const [origin, setOrigin] = useState(job?.origin);
  const [destination, setDestination] = useState(job?.destination);
  const blank = { label: '', lat: NaN, lon: NaN };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void action.run(async () => {
      if (!Number.isFinite(origin?.lat) || !Number.isFinite(destination?.lat)) {
        throw new Error('Choose pickup and delivery from the search suggestions.');
      }
      await fleet(
        job ? `jobs/${job.id}` : 'jobs',
        {
          origin,
          destination,
          driver: Number(values.get('driver')),
          load_weight_lb: Number(values.get('load')),
          departure: new Date(String(values.get('departure'))).toISOString(),
          deadline: new Date(String(values.get('deadline'))).toISOString(),
        },
        job ? 'PUT' : 'POST',
      );
      if (!job) {
        form.reset();
        setOrigin(undefined);
        setDestination(undefined);
      }
      saved();
    });
  }
  return (
    <form className="fleet-form" onSubmit={submit}>
      <PlaceInput label="Pickup" value={origin ?? blank} onChange={setOrigin} />
      <PlaceInput label="Delivery" value={destination ?? blank} onChange={setDestination} />
      <div className="fleet-fields">
        <label>
          Driver
          <select name="driver" aria-label="Driver" required defaultValue={job?.driver_id ?? ''}>
            <option value="">Select a driver</option>
            {drivers
              .filter((driver) => driver.active)
              .map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Cargo weight (lb)
          <input
            name="load"
            type="number"
            required
            min={0}
            max={80000}
            defaultValue={job?.load_weight_lb ?? 0}
          />
        </label>
        <label>
          Departure (local time)
          <input
            name="departure"
            type="datetime-local"
            required
            defaultValue={job ? localInput(job.departure) : localInput(Date.now() + 3600000)}
          />
        </label>
        <label>
          Delivery deadline (local time)
          <input
            name="deadline"
            type="datetime-local"
            required
            defaultValue={job ? localInput(job.deadline) : undefined}
          />
        </label>
      </div>
      <button className="fleet-primary" disabled={action.busy}>
        {job ? 'Save assignment' : 'Assign job'}
      </button>
      {action.message && <p role="alert">{action.message}</p>}
    </form>
  );
}

function Roster({ drivers, jobs, refresh }: { drivers: Driver[]; jobs: Job[]; refresh: () => void }) {
  const action = useAction();
  const [notice, setNotice] = useState('');
  const [setupUrl, setSetupUrl] = useState('');
  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setNotice('');
    setSetupUrl('');
    void action.run(async () => {
      try {
        const result = await fleet<{ setup_url?: string }>('drivers', values);
        form.reset();
        setSetupUrl(result.setup_url ? new URL(result.setup_url, location.origin).href : '');
        setNotice(
          result.setup_url ? 'Share this one-time link privately with the driver.' : 'Invitation sent.',
        );
      } finally {
        refresh();
      }
    });
  }
  return (
    <section className="fleet-panel">
      <h2>Drivers</h2>
      <form className="fleet-form" onSubmit={invite}>
        <div className="fleet-fields">
          <label>
            Name
            <input name="name" required maxLength={150} />
          </label>
          <label>
            Email
            <input name="email" type="email" required maxLength={150} />
          </label>
        </div>
        <button className="fleet-primary" disabled={action.busy}>
          Invite driver
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {setupUrl && (
        <div className="fleet-form">
          <label>
            One-time setup link
            <input readOnly value={setupUrl} onFocus={(event) => event.target.select()} />
          </label>
          <button
            type="button"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await navigator.clipboard.writeText(setupUrl);
                setNotice('Setup link copied.');
              })
            }
          >
            Copy link
          </button>
        </div>
      )}
      {action.message && <p role="alert">{action.message}</p>}
      <ul className="fleet-list">
        {drivers.map((driver) => {
          const active = jobs.filter((job) => job.driver_id === driver.id && !closed(job));
          return (
            <li key={driver.id}>
              <div>
                <strong>{driver.name}</strong>
                <small>{driver.email}</small>
                <small>
                  {!driver.active ? 'Inactive · ' : ''}
                  {active.length
                    ? `${active.length} active ${active.length === 1 ? 'job' : 'jobs'}`
                    : 'No active jobs'}
                </small>
              </div>
              <div className="fleet-actions">
                {driver.active && (
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const result = await fleet<{ setup_url: string }>(
                          `drivers/${driver.id}/setup-link`,
                          {},
                        );
                        setSetupUrl(new URL(result.setup_url, location.origin).href);
                        setNotice(`Share this one-time link privately with ${driver.name}.`);
                      })
                    }
                  >
                    Setup link
                  </button>
                )}
                <button
                  disabled={action.busy}
                  onClick={() => {
                    setNotice('');
                    setSetupUrl('');
                    void action.run(async () => {
                      await fleet(`drivers/${driver.id}`, { active: !driver.active }, 'PATCH');
                      refresh();
                    });
                  }}
                >
                  {driver.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function JobBoard({ jobs, admin }: { jobs: Job[]; admin: boolean }) {
  return (
    <section className="fleet-panel">
      <h2>{admin ? 'Job board' : 'My jobs'}</h2>
      {jobs.length === 0 ? (
        <p>No jobs assigned yet.</p>
      ) : (
        <div className="fleet-table">
          <table>
            <thead>
              <tr>
                <th>Delivery</th>
                {admin && <th>Driver</th>}
                <th>Progress</th>
                <th>Schedule</th>
                <th>Deadline</th>
                <th>Latest ETA</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {[...jobs]
                .sort((a, b) => (priority[a.risk] ?? 5) - (priority[b.risk] ?? 5))
                .map((job) => (
                  <tr key={job.id}>
                    <th scope="row">
                      <a href={`/fleet/jobs/${job.id}`}>{title(job)}</a>
                    </th>
                    {admin && <td data-label="Driver">{job.driver_name}</td>}
                    <td data-label="Progress" className="fleet-state">
                      {label(job.status)}
                    </td>
                    <td data-label="Schedule" className="fleet-state" data-risk={job.risk}>
                      {label(job.risk)}
                    </td>
                    <td data-label="Deadline">{date(job.deadline)}</td>
                    <td data-label="Latest ETA">{date(job.eta)}</td>
                    <td data-label="Last update">{date(job.updated_at)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Dashboard({ user }: { user: User }) {
  const admin = user.role === 'admin';
  const jobs = useQuery({
    queryKey: ['fleet-jobs', user.id],
    queryFn: () => fleet<Job[]>('jobs'),
    refetchInterval: 15000,
  });
  const drivers = useQuery({
    queryKey: ['fleet-drivers', user.id],
    queryFn: () => fleet<Driver[]>('drivers'),
    enabled: admin,
  });
  return (
    <Layout user={user}>
      <h1>{admin ? user.company : 'Driver workspace'}</h1>
      {(jobs.isError || (admin && drivers.isError)) && <p role="alert">Unable to load fleet data.</p>}
      {jobs.isPending && <p role="status">Loading jobs…</p>}
      {jobs.data && <JobBoard jobs={jobs.data} admin={admin} />}
      {admin && drivers.data && (
        <div className="fleet-grid">
          <section className="fleet-panel">
            <h2>Assign a job</h2>
            <JobForm drivers={drivers.data} saved={() => void jobs.refetch()} />
          </section>
          <Roster drivers={drivers.data} jobs={jobs.data ?? []} refresh={() => void drivers.refetch()} />
        </div>
      )}
    </Layout>
  );
}

function Progress({ job, admin, refresh }: { job: Job; admin: boolean; refresh: () => void }) {
  const action = useAction();
  function update(payload: object, form?: HTMLFormElement) {
    void action.run(async () => {
      await fleet(`jobs/${job.id}/updates`, payload);
      form?.reset();
      refresh();
    });
  }
  if (closed(job)) return null;
  return (
    <section className="fleet-panel">
      <h2>Update job</h2>
      <div className="fleet-actions">
        {admin ? (
          <button
            disabled={action.busy}
            onClick={() => {
              if (confirm('Cancel this delivery?')) update({ status: 'cancelled' });
            }}
          >
            Cancel job
          </button>
        ) : (
          <>
            <a className="fleet-primary" href={`/fleet/jobs/${job.id}/plan`}>
              Open in route planner
            </a>
            {job.status !== 'en_route' && (
              <button disabled={action.busy} onClick={() => update({ status: 'en_route' })}>
                Mark en route
              </button>
            )}
            <button disabled={action.busy} onClick={() => update({ status: 'delivered' })}>
              Mark delivered
            </button>
          </>
        )}
      </div>
      {!admin && (
        <form
          className="fleet-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const note = String(data.get('note')).trim();
            update(
              {
                eta: new Date(String(data.get('eta'))).toISOString(),
                ...(note ? { status: 'delayed', note } : {}),
              },
              form,
            );
          }}
        >
          <div className="fleet-fields">
            <label>
              Revised ETA (local time)
              <input name="eta" type="datetime-local" required />
            </label>
            <label>
              Delay reason
              <input name="note" maxLength={500} placeholder="Leave blank to update ETA only" />
            </label>
          </div>
          <button disabled={action.busy}>Save update</button>
        </form>
      )}
      {action.message && <p role="alert">{action.message}</p>}
    </section>
  );
}

function JobPage({ user, id, planning }: { user: User; id: string; planning: boolean }) {
  const admin = user.role === 'admin';
  const detail = useQuery({ queryKey: ['fleet-job', user.id, id], queryFn: () => fleet<Job>(`jobs/${id}`) });
  const drivers = useQuery({
    queryKey: ['fleet-drivers', user.id],
    queryFn: () => fleet<Driver[]>('drivers'),
    enabled: admin,
  });
  const action = useAction();
  const job = detail.data;
  if (!job)
    return (
      <Layout user={user}>
        <p role={detail.isError ? 'alert' : 'status'}>
          {detail.isError ? 'This job is unavailable.' : 'Loading job…'}
        </p>
      </Layout>
    );
  if (planning && !admin && !closed(job)) {
    const departure = Math.max(Date.parse(job.departure), Date.now());
    return (
      <>
        {action.message && (
          <p className="fleet-planner-feedback" role="alert">
            {action.message}
          </p>
        )}
        {action.busy && (
          <p className="fleet-planner-feedback" role="status">
            Saving route…
          </p>
        )}
        <App
          fleetLink={`/fleet/jobs/${id}`}
          initialPlan={{
            origin: job.origin,
            destination: job.destination,
            load_weight_lb: job.load_weight_lb,
            departure_local: localInput(departure),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }}
          onConfirmRoute={
            action.busy
              ? undefined
              : (analysis, route) =>
                  void action.run(async () => {
                    await fleet(`jobs/${id}/updates`, { analysis_id: analysis.id, route_id: route.id });
                    location.replace(`/fleet/jobs/${id}`);
                  })
          }
        />
      </>
    );
  }
  return (
    <Layout user={user}>
      <a href="/fleet">Back to {admin ? 'fleet' : 'my jobs'}</a>
      <h1>{title(job)}</h1>
      <section className="fleet-panel">
        <dl className="fleet-details">
          <div>
            <dt>Driver</dt>
            <dd>{job.driver_name}</dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd className="fleet-state">{label(job.status)}</dd>
          </div>
          <div>
            <dt>Schedule</dt>
            <dd className="fleet-state">{label(job.risk)}</dd>
          </div>
          <div>
            <dt>Departure</dt>
            <dd>{date(job.departure)}</dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>{date(job.deadline)}</dd>
          </div>
          <div>
            <dt>Latest ETA</dt>
            <dd>{date(job.eta)}</dd>
          </div>
          {job.eta_updated_at && (
            <div>
              <dt>ETA updated</dt>
              <dd>{date(job.eta_updated_at)}</dd>
            </div>
          )}
          {job.delivered_at && (
            <div>
              <dt>Delivered</dt>
              <dd>{date(job.delivered_at)}</dd>
            </div>
          )}
          {job.route && (
            <div>
              <dt>Selected route</dt>
              <dd>{job.route.label}</dd>
            </div>
          )}
        </dl>
      </section>
      <Progress job={job} admin={admin} refresh={() => void detail.refetch()} />
      {admin && !closed(job) && drivers.data && (
        <section className="fleet-panel">
          <h2>Edit assignment</h2>
          <JobForm
            key={job.updated_at}
            drivers={drivers.data}
            job={job}
            saved={() => void detail.refetch()}
          />
        </section>
      )}
      <section className="fleet-panel">
        <h2>Job history</h2>
        <ul className="fleet-list">
          {job.history?.map((entry, index) => (
            <li key={index}>
              <div>
                <strong className="fleet-state">{label(entry.status)}</strong>
                {entry.note && <p>{entry.note}</p>}
                {entry.eta && <small>ETA {date(entry.eta)}</small>}
              </div>
              <time dateTime={entry.created_at}>{date(entry.created_at)}</time>
            </li>
          ))}
        </ul>
      </section>
    </Layout>
  );
}

export default function Fleet() {
  const session = useQuery({
    queryKey: ['fleet-session'],
    queryFn: () => fleet<{ user: User | null; email_enabled: boolean }>('session'),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
  });
  const user = session.data?.user;
  const path = location.pathname.replace(/\/$/, '');
  const reset = path === '/fleet/reset';
  useEffect(() => {
    if (!user && session.isSuccess && !reset && path !== '/fleet') location.replace('/fleet');
  }, [user, session.isSuccess, reset, path]);
  if (session.isPending)
    return (
      <Layout>
        <p role="status">Loading session…</p>
      </Layout>
    );
  if (session.isError)
    return (
      <Layout>
        <p role="alert">Unable to load your session.</p>
      </Layout>
    );
  if (!user || reset) return <Account reset={reset} emailEnabled={Boolean(session.data?.email_enabled)} />;
  const job = path.match(/^\/fleet\/jobs\/(\d+)(\/plan)?$/);
  return job ? <JobPage user={user} id={job[1]} planning={Boolean(job[2])} /> : <Dashboard user={user} />;
}
