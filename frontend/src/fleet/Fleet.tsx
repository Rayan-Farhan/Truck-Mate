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

interface Truck {
  id: number;
  registration: string;
  model: string;
  capacity_lb: number;
  available: boolean;
}

interface Job {
  id: number;
  driver_id: number;
  driver_name: string;
  truck_id: number | null;
  truck_registration: string | null;
  cargo_type: string;
  customer_name: string;
  instructions: string;
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
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40">
              <path d="M7 12h16v15H7zM23 18h6l5 6v3H23M23 24h11" />
              <circle cx="13" cy="29" r="3" />
              <circle cx="28" cy="29" r="3" />
            </svg>
          </span>
          <span>
            TruckMate<span className="brand-period">.</span>
          </span>
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

function Account({ page, emailEnabled }: { page: string; emailEnabled: boolean }) {
  const reset = page === '/fleet/reset';
  const recovery = page === '/fleet/recover';
  const register = page === '/fleet/register';
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
      } else if (register) {
        await fleet('register', { ...data, email: data.username });
        location.replace('/fleet?registered=1');
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
        <h1>
          {register
            ? 'Register your fleet'
            : reset
              ? 'Set your password'
              : recovery
                ? 'Reset your password'
                : 'Fleet sign-in'}
        </h1>
        {page === '/fleet' && new URLSearchParams(location.search).has('registered') && (
          <p role="status">Your fleet is ready. Sign in with your new account.</p>
        )}
        {sent ? (
          <p role="status">If the account exists, we’ll send a password reset link.</p>
        ) : recovery && !emailEnabled ? (
          <p>Email recovery is unavailable. Contact your fleet administrator or support for a reset link.</p>
        ) : (
          <form className="fleet-form" onSubmit={submit}>
            {register && (
              <label>
                Company name
                <input name="company" autoComplete="organization" required maxLength={150} />
              </label>
            )}
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
                  autoComplete={reset || register ? 'new-password' : 'current-password'}
                />
              </label>
            )}
            <button className="fleet-primary" disabled={action.busy}>
              {register
                ? 'Create fleet account'
                : reset
                  ? 'Save password'
                  : recovery
                    ? 'Send reset link'
                    : 'Sign in'}
            </button>
          </form>
        )}
        {action.message && <p role="alert">{action.message}</p>}
        {reset || recovery || register ? (
          <a href="/fleet">Back to sign-in</a>
        ) : (
          <nav className="fleet-actions" aria-label="Account options">
            <a href="/fleet/recover">Forgot your password?</a>
            <a href="/fleet/register">Register a fleet</a>
          </nav>
        )}
      </section>
    </Layout>
  );
}

function JobForm({
  drivers,
  trucks,
  job,
  saved,
}: {
  drivers: Driver[];
  trucks: Truck[];
  job?: Job;
  saved: () => void;
}) {
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
          truck: Number(values.get('truck')) || null,
          cargo_type: values.get('cargo_type'),
          customer_name: values.get('customer_name'),
          instructions: values.get('instructions'),
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
          Truck
          <select name="truck" aria-label="Truck" defaultValue={job?.truck_id ?? ''}>
            <option value="">Unassigned</option>
            {trucks
              .filter((truck) => truck.available || truck.id === job?.truck_id)
              .map((truck) => (
                <option key={truck.id} value={truck.id}>
                  {truck.registration} · {truck.capacity_lb.toLocaleString()} lb
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
      <div className="fleet-fields">
        <label>
          Cargo type
          <input name="cargo_type" maxLength={100} defaultValue={job?.cargo_type} />
        </label>
        <label>
          Customer
          <input name="customer_name" maxLength={150} defaultValue={job?.customer_name} />
        </label>
      </div>
      <label>
        Dispatch instructions
        <textarea name="instructions" maxLength={1000} rows={3} defaultValue={job?.instructions} />
      </label>
      <button className="fleet-primary" disabled={action.busy}>
        {job ? 'Save assignment' : 'Assign job'}
      </button>
      {action.message && <p role="alert">{action.message}</p>}
    </form>
  );
}

function Roster({ drivers, jobs, refresh }: { drivers: Driver[]; jobs: Job[]; refresh: () => void }) {
  const action = useAction();
  const [editing, setEditing] = useState<Driver>();
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
        if (editing) {
          await fleet(`drivers/${editing.id}`, { name: values.name }, 'PATCH');
          setEditing(undefined);
          setNotice('Driver updated.');
          return;
        }
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
      <form key={editing?.id ?? 'invite'} className="fleet-form" onSubmit={invite}>
        <div className="fleet-fields">
          <label>
            Name
            <input name="name" required maxLength={150} defaultValue={editing?.name} />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              maxLength={150}
              readOnly={Boolean(editing)}
              defaultValue={editing?.email}
            />
          </label>
        </div>
        <div className="fleet-actions">
          <button className="fleet-primary" disabled={action.busy}>
            {editing ? 'Save driver' : 'Invite driver'}
          </button>
          {editing && (
            <button type="button" onClick={() => setEditing(undefined)}>
              Cancel edit
            </button>
          )}
        </div>
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
                <button type="button" disabled={action.busy} onClick={() => setEditing(driver)}>
                  Edit driver
                </button>
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

function TruckRoster({ trucks, refresh }: { trucks: Truck[]; refresh: () => void }) {
  const action = useAction();
  const [editing, setEditing] = useState<Truck>();
  return (
    <section className="fleet-panel">
      <h2>Trucks</h2>
      <form
        key={editing?.id ?? 'new'}
        className="fleet-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void action.run(async () => {
            await fleet(
              editing ? `trucks/${editing.id}` : 'trucks',
              {
                registration: data.get('registration'),
                model: data.get('model'),
                capacity_lb: Number(data.get('capacity')),
                available: data.has('available'),
              },
              editing ? 'PATCH' : 'POST',
            );
            form.reset();
            setEditing(undefined);
            refresh();
          });
        }}
      >
        <div className="fleet-fields">
          <label>
            Registration
            <input name="registration" required maxLength={32} defaultValue={editing?.registration} />
          </label>
          <label>
            Model
            <input name="model" required maxLength={100} defaultValue={editing?.model} />
          </label>
          <label>
            Payload capacity (lb)
            <input
              name="capacity"
              type="number"
              min={1}
              max={80000}
              required
              defaultValue={editing?.capacity_lb}
            />
          </label>
          <label className="fleet-checkbox">
            <input name="available" type="checkbox" defaultChecked={editing?.available ?? true} /> Available
            for dispatch
          </label>
        </div>
        <div className="fleet-actions">
          <button className="fleet-primary" disabled={action.busy}>
            {editing ? 'Save truck' : 'Add truck'}
          </button>
          {editing && (
            <button type="button" onClick={() => setEditing(undefined)}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      {action.message && <p role="alert">{action.message}</p>}
      <ul className="fleet-list">
        {trucks.map((truck) => (
          <li key={truck.id}>
            <div>
              <strong>{truck.registration}</strong>
              <small>
                {truck.model} · {truck.capacity_lb.toLocaleString()} lb ·{' '}
                {truck.available ? 'Available' : 'Unavailable'}
              </small>
            </div>
            <div className="fleet-actions">
              <button disabled={action.busy} onClick={() => setEditing(truck)}>
                Edit truck
              </button>
              <button
                disabled={action.busy}
                onClick={() => {
                  if (!confirm(`Remove truck ${truck.registration}?`)) return;
                  void action.run(async () => {
                    await fleet(`trucks/${truck.id}`, undefined, 'DELETE');
                    if (editing?.id === truck.id) setEditing(undefined);
                    refresh();
                  });
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useTrucks(user: User) {
  return useQuery({
    queryKey: ['fleet-trucks', user.id],
    queryFn: () => fleet<Truck[]>('trucks'),
    enabled: user.role === 'admin',
  });
}

function Dashboard({ user }: { user: User }) {
  const admin = user.role === 'admin';
  const trucks = useTrucks(user);
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
      {admin && jobs.data && drivers.data && trucks.data && (
        <dl className="fleet-overview" aria-label="Fleet overview">
          <div>
            <dt>Trucks</dt>
            <dd>{trucks.data.length}</dd>
          </div>
          <div>
            <dt>Active drivers</dt>
            <dd>{drivers.data.filter((driver) => driver.active).length}</dd>
          </div>
          <div>
            <dt>Active deliveries</dt>
            <dd>{jobs.data.filter((job) => !closed(job)).length}</dd>
          </div>
          <div>
            <dt>At risk or overdue</dt>
            <dd>{jobs.data.filter((job) => ['at_risk', 'overdue'].includes(job.risk)).length}</dd>
          </div>
        </dl>
      )}
      {(jobs.isError || (admin && drivers.isError)) && <p role="alert">Unable to load fleet data.</p>}
      {jobs.isPending && <p role="status">Loading jobs…</p>}
      {jobs.data && <JobBoard jobs={jobs.data} admin={admin} />}
      {admin && drivers.data && (
        <div className="fleet-grid">
          <section className="fleet-panel">
            <h2>Assign a job</h2>
            <JobForm drivers={drivers.data} trucks={trucks.data ?? []} saved={() => void jobs.refetch()} />
          </section>
          <Roster drivers={drivers.data} jobs={jobs.data ?? []} refresh={() => void drivers.refetch()} />
        </div>
      )}
      {admin && trucks.isError && <p role="alert">Unable to load trucks.</p>}
      {admin && trucks.data && <TruckRoster trucks={trucks.data} refresh={() => void trucks.refetch()} />}
    </Layout>
  );
}

const pickupSteps: Record<string, [string, string]> = {
  assigned: ['accepted', 'Accept delivery'],
  accepted: ['arrived', 'Arrived at pickup'],
  arrived: ['picked_up', 'Mark picked up'],
};

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
  const pickupStep = pickupSteps[job.status];
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
            {pickupStep && (
              <button disabled={action.busy} onClick={() => update({ status: pickupStep[0] })}>
                {pickupStep[1]}
              </button>
            )}
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
  const trucks = useTrucks(user);
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
          {job.truck_registration && (
            <div>
              <dt>Truck</dt>
              <dd>{job.truck_registration}</dd>
            </div>
          )}
          {job.cargo_type && (
            <div>
              <dt>Cargo</dt>
              <dd>
                {job.cargo_type} · {job.load_weight_lb.toLocaleString()} lb
              </dd>
            </div>
          )}
          {job.customer_name && (
            <div>
              <dt>Customer</dt>
              <dd>{job.customer_name}</dd>
            </div>
          )}
          {job.instructions && (
            <div>
              <dt>Dispatch instructions</dt>
              <dd>{job.instructions}</dd>
            </div>
          )}
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
            trucks={trucks.data ?? []}
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
  const accountPage = ['/fleet/reset', '/fleet/recover', '/fleet/register'].includes(path);
  useEffect(() => {
    if (!user && session.isSuccess && !accountPage && path !== '/fleet') location.replace('/fleet');
  }, [user, session.isSuccess, accountPage, path]);
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
  if (!user || accountPage)
    return <Account page={path} emailEnabled={Boolean(session.data?.email_enabled)} />;
  const job = path.match(/^\/fleet\/jobs\/(\d+)(\/plan)?$/);
  return job ? <JobPage user={user} id={job[1]} planning={Boolean(job[2])} /> : <Dashboard user={user} />;
}
