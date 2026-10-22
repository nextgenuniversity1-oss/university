import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Wallet } from 'lucide-react';
import { api, messageOf } from '../../api';

type FinanceUser = { role: string };
type FeeSchedule = { _id: string; title: string; status: string; reference: string; data: { code: string; name: string; amountNaira: number; currency: string; session: string; description?: string; decisionReason?: string; proposedBy?: string } };
type FinanceException = { _id: string; title: string; status: string; reference: string; createdAt?: string; data: { paymentReference?: string; expectedKobo?: number; actualKobo?: number; actualCurrency?: string; exceptionType?: string; resolution?: string; resolutionReason?: string } };
const money = (n: unknown) => Number.isFinite(Number(n)) ? new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(Number(n)) : '—';

export default function FinanceWorkspace({ user }: { user: FinanceUser }) {
  const isBursary = user.role === 'BURSARY';
  const isRegistrar = user.role === 'REGISTRAR';
  const [schedules, setSchedules] = useState<FeeSchedule[]>([]);
  const [exceptions, setExceptions] = useState<FinanceException[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ code: '', name: '', amountNaira: '', session: '', description: '' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [resolutionTypes, setResolutionTypes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [scheduleResult, exceptionResult] = await Promise.all([
        api.get('/payments/fee-schedules'), api.get('/payments/exceptions')
      ]);
      setSchedules(scheduleResult.data.schedules || []);
      setExceptions(exceptionResult.data.exceptions || []);
    } catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function proposeFee(e: FormEvent) {
    e.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      const amountNaira = Number(form.amountNaira);
      if (!Number.isFinite(amountNaira) || amountNaira <= 0) throw new Error('Enter a valid positive fee amount.');
      const result = await api.post('/payments/fee-schedules', { ...form, code: form.code.toUpperCase().trim(), amountNaira, currency: 'NGN' });
      setNotice(result.data.message || 'Fee schedule submitted for Registrar approval.');
      setForm({ code: '', name: '', amountNaira: '', session: '', description: '' }); await load();
    } catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  }
  async function decideFee(id: string, decision: 'APPROVE' | 'REJECT') {
    const reason = (reasons[id] || '').trim();
    if (reason.length < 8) { setError('Provide a reason of at least 8 characters for the fee decision.'); return; }
    setError(''); setNotice(''); setBusy(true);
    try { await api.post(`/payments/fee-schedules/${id}/approve`, { decision, reason }); setNotice(`Fee schedule ${decision.toLowerCase()}d.`); await load(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  async function resolveException(id: string) {
    const resolution = resolutions[id] || 'CONFIRMED_PROVIDER_RECORD';
    const reason = (reasons[`exception:${id}`] || '').trim();
    if (reason.length < 10) { setError('Provide an investigation explanation of at least 10 characters.'); return; }
    setError(''); setNotice(''); setBusy(true);
    try { const result = await api.post(`/payments/exceptions/${id}/resolve`, { resolution, reason }); setNotice(result.data.message || 'Exception review recorded.'); await load(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <section className="rounded-2xl bg-forest text-white p-7 md:p-9">
      <p className="text-xs uppercase tracking-[.18em] text-emerald-200 font-bold">Finance controls</p>
      <h1 className="text-3xl font-bold mt-3">Fees &amp; payment reconciliation</h1>
      <p className="text-emerald-50/80 mt-3 max-w-3xl leading-7">Manage official fee proposals and investigate payment exceptions. Bursary proposes fees and investigates exceptions; only the Registrar can approve or reject a fee schedule.</p>
    </section>
    <div className="grid sm:grid-cols-3 gap-3">
      <div className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-500">Fee schedules</p><p className="text-2xl font-bold mt-1">{schedules.length}</p></div>
      <div className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-500">Awaiting Registrar</p><p className="text-2xl font-bold mt-1">{schedules.filter(s => s.status === 'PROPOSED').length}</p></div>
      <div className="rounded-xl border bg-white p-4"><p className="text-sm text-slate-500">Open exceptions</p><p className="text-2xl font-bold mt-1">{exceptions.filter(x => x.status === 'OPEN').length}</p></div>
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-50 text-red-700 p-4 text-sm">{error}</div>}
    {notice && <div role="status" className="rounded-xl bg-emerald-50 text-emerald-800 p-4 text-sm">{notice}</div>}
    <div className="flex justify-end"><button type="button" onClick={() => void load()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><RefreshCw size={16}/>{busy ? 'Refreshing…' : 'Refresh records'}</button></div>

    {isBursary && <form onSubmit={proposeFee} className="rounded-2xl border bg-white p-5 md:p-6">
      <div className="flex items-center gap-2"><Wallet size={20}/><h2 className="text-lg font-bold">Propose an official fee</h2></div>
      <p className="text-sm text-slate-500 mt-1">Use a stable fee code for each fee and session. The amount becomes chargeable only after Registrar approval.</p>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 mt-5">
        <label className="text-sm font-medium">Fee code<input required maxLength={40} className="field mt-1" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="TUITION-100L"/></label>
        <label className="text-sm font-medium">Fee name<input required minLength={3} maxLength={120} className="field mt-1" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Undergraduate tuition"/></label>
        <label className="text-sm font-medium">Amount (₦)<input required type="number" min="1" max="10000000" step="0.01" className="field mt-1" value={form.amountNaira} onChange={e => setForm({ ...form, amountNaira: e.target.value })} placeholder="250000"/></label>
        <label className="text-sm font-medium">Academic session<input required minLength={4} maxLength={30} className="field mt-1" value={form.session} onChange={e => setForm({ ...form, session: e.target.value })} placeholder="2026/2027"/></label>
        <label className="text-sm font-medium md:col-span-2">Description (optional)<input maxLength={500} className="field mt-1" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Who this fee applies to and what it covers"/></label>
      </div>
      <button disabled={busy} className="mt-5 rounded-xl bg-forest px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Submitting…' : 'Submit for Registrar approval'}</button>
    </form>}

    <section className="rounded-2xl border bg-white p-5 md:p-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold">Official fee schedules</h2><span className="text-xs text-slate-500">{schedules.length} records</span></div>
      <div className="mt-4 space-y-3">{schedules.map(s => <article key={s._id} className="rounded-xl border p-4">
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{s.title || s.data.name}</h3><p className="text-sm text-slate-500 mt-1">{s.data.code} · {s.data.session} · {s.reference}</p></div><span className={`h-fit rounded-full px-3 py-1 text-xs font-semibold ${s.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800' : s.status === 'REJECTED' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-900'}`}>{s.status.replaceAll('_', ' ')}</span></div>
        <p className="text-xl font-bold mt-3">{money(s.data.amountNaira)}</p>{s.data.description && <p className="text-sm text-slate-600 mt-1">{s.data.description}</p>}{s.data.decisionReason && <p className="text-sm text-slate-500 mt-2">Decision reason: {s.data.decisionReason}</p>}
        {isRegistrar && s.status === 'PROPOSED' && <div className="mt-4 border-t pt-4"><label className="block text-sm font-medium">Decision reason<textarea required minLength={8} className="field mt-1" rows={2} value={reasons[s._id] || ''} onChange={e => setReasons({ ...reasons, [s._id]: e.target.value })} placeholder="Explain why the schedule is approved or rejected"/></label><div className="flex flex-wrap gap-2 mt-3"><button type="button" disabled={busy} onClick={() => void decideFee(s._id, 'APPROVE')} className="inline-flex items-center gap-2 rounded-lg bg-forest px-4 py-2 text-sm font-semibold text-white"><CheckCircle2 size={16}/>Approve fee</button><button type="button" disabled={busy} onClick={() => void decideFee(s._id, 'REJECT')} className="rounded-lg border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700">Reject proposal</button></div></div>}
      </article>)}{!schedules.length && <p className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">No fee schedules have been proposed yet.</p>}</div>
    </section>

    <section className="rounded-2xl border bg-white p-5 md:p-6">
      <div className="flex items-center gap-2"><AlertTriangle size={20}/><h2 className="text-lg font-bold">Payment exceptions</h2></div>
      <p className="text-sm text-slate-500 mt-1">Mismatched amount, currency, or provider status needs investigation. Recording a resolution does not mark a payment as paid or issue a refund.</p>
      <div className="mt-4 space-y-3">{exceptions.map(x => <article key={x._id} className="rounded-xl border p-4">
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{x.title}</h3><p className="text-xs text-slate-500 mt-1">{x.data.paymentReference || x.reference} · {x.data.exceptionType || 'Payment review'}</p></div><span className={`h-fit rounded-full px-3 py-1 text-xs font-semibold ${x.status === 'OPEN' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>{x.status}</span></div>
        <div className="grid sm:grid-cols-3 gap-3 mt-3 text-sm"><p className="rounded-lg bg-slate-50 p-3"><span className="block text-xs text-slate-500">Expected</span>{money(Number(x.data.expectedKobo || 0) / 100)}</p><p className="rounded-lg bg-slate-50 p-3"><span className="block text-xs text-slate-500">Provider reported</span>{x.data.actualKobo == null ? '—' : money(Number(x.data.actualKobo) / 100)}</p><p className="rounded-lg bg-slate-50 p-3"><span className="block text-xs text-slate-500">Currency reported</span>{x.data.actualCurrency || '—'}</p></div>
        {x.data.resolutionReason && <p className="text-sm text-slate-600 mt-3">Resolution: {x.data.resolution} — {x.data.resolutionReason}</p>}
        {isBursary && x.status === 'OPEN' && <div className="mt-4 border-t pt-4"><div className="grid md:grid-cols-2 gap-3"><label className="text-sm font-medium">Investigation outcome<select className="field mt-1" value={resolutionTypes[x._id] || 'CONFIRMED_PROVIDER_RECORD'} onChange={e => setResolutionTypes({ ...resolutionTypes, [x._id]: e.target.value })}><option value="CONFIRMED_PROVIDER_RECORD">Provider record confirmed</option><option value="DUPLICATE">Duplicate transaction</option><option value="REFUND_REQUIRED">Refund required (separate process)</option><option value="ESCALATED">Escalated for further review</option></select></label><label className="text-sm font-medium">Investigation explanation<textarea minLength={10} className="field mt-1" rows={2} value={reasons[`exception:${x._id}`] || ''} onChange={e => setReasons({ ...reasons, [`exception:${x._id}`]: e.target.value })} placeholder="Describe what was checked and what should happen next"/></label></div><button type="button" disabled={busy} onClick={() => void resolveException(x._id)} className="mt-3 rounded-lg bg-forest px-4 py-2 text-sm font-semibold text-white">Record investigation outcome</button></div>}
      </article>)}{!exceptions.length && <p className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">No finance exceptions have been recorded.</p>}</div>
    </section>
  </div>;
}
