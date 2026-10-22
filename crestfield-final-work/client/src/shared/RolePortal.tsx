import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
export type RoleLink = {label:string;path:string};
export default function RolePortal({title,description,links}:{title:string;description:string;links:readonly RoleLink[]}) {
 return <section className="space-y-6">
  <div className="rounded-2xl bg-forest text-white p-7 md:p-9">
   <p className="text-xs uppercase tracking-[.18em] text-emerald-200 font-bold">Role workspace</p>
   <h1 className="text-3xl font-bold mt-3">{title}</h1><p className="text-emerald-50/80 mt-3 max-w-2xl leading-7">{description}</p>
  </div>
  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex gap-3 text-sm text-amber-950"><ShieldCheck size={20} className="shrink-0"/><p>Actions are subject to server-side role permissions and approval workflows. A visible menu item does not grant authority to approve a record.</p></div>
  <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">{links.map(link=><Link key={link.path+link.label} to={link.path} className="group bg-white border border-slate-100 rounded-2xl p-5 hover:border-emerald-200 hover:shadow-sm transition"><div className="flex items-start justify-between gap-3"><h2 className="font-bold">{link.label}</h2><ArrowUpRight size={18} className="text-slate-400 group-hover:text-emerald-700"/></div><p className="text-sm text-slate-500 mt-2">Open this workspace to view records and available actions.</p></Link>)}</div>
 </section>;
}
