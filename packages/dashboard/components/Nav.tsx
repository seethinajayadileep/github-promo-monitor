export function Nav() {
  return (
    <div className="border-b border-slate-800 bg-slate-950">
      <nav className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 text-sm sm:px-6">
        <a className="font-semibold text-slate-100" href="/">Promos</a>
        <a className="text-sky-300 hover:text-sky-200" href="/stats">Stats</a>
        <span className="ml-auto text-xs text-slate-500">Times in IST (Asia/Kolkata)</span>
      </nav>
    </div>
  );
}
