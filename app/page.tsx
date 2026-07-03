"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "@/lib/strings";

interface Worker {
  name: string;
  hours: number | null;
  isNew?: boolean;
}

const DRAFT_KEY = "ammex_tc_draft_v1";
const FOREMAN_KEY = "ammex_tc_foreman_v1";
const LANG_KEY = "ammex_tc_lang_v1";
const LASTCREW_KEY = "ammex_tc_lastcrew_v1";

const QUICK_HOURS = [4, 6, 8, 10];

function todayISO(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

// Friendly, bilingual date like "Tuesday, Jun 30" / "Martes, 30 jun".
function friendlyDate(iso: string, lang: "en" | "es"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const daysEn = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const daysEs = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const monEn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monEs = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  return lang === "es"
    ? `${daysEs[dow]}, ${d} ${monEs[m - 1]}`
    : `${daysEn[dow]}, ${monEn[m - 1]} ${d}`;
}

export default function Page() {
  const [lang, setLang] = useState<Lang>("es");
  const tr = t(lang);

  const [foreman, setForeman] = useState<string>("");
  const [showForemanPicker, setShowForemanPicker] = useState(false);

  const [date, setDate] = useState<string>(todayISO());
  // The date came from a leftover draft on a previous day and hasn't been
  // confirmed by the worker. If so, we ask "which day?" at Review time.
  const staleUnconfirmed = useRef(false);
  const [showDatePrompt, setShowDatePrompt] = useState(false);
  const dateFieldRef = useRef<HTMLDivElement>(null);
  const [datePulse, setDatePulse] = useState(false);

  // "Other date" from the prompt: close it, bring the date field into view,
  // then pulse it so the worker sees where to change the date.
  function goToDateField() {
    setShowDatePrompt(false);
    setTimeout(() => {
      dateFieldRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setDatePulse(true);
      setTimeout(() => setDatePulse(false), 2600);
    }, 60);
  }
  const [job, setJob] = useState("");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [workDone, setWorkDone] = useState("");
  const [notes, setNotes] = useState("");

  const [roster, setRoster] = useState<string[]>([]);
  const [foremen, setForemen] = useState<string[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showRecon, setShowRecon] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  // PIN gates the hamburger (admin area); unlock lasts the session so Reports
  // and Schedule share one entry.
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [adminPinError, setAdminPinError] = useState(false);
  const [query, setQuery] = useState("");

  const [screen, setScreen] = useState<"form" | "review">("form");
  const [submitState, setSubmitState] = useState<
    "idle" | "submitting" | "sent" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [selfRemoveName, setSelfRemoveName] = useState<string | null>(null);
  const [validationMsg, setValidationMsg] = useState("");

  const hydrated = useRef(false);
  const addBoxRef = useRef<HTMLDivElement>(null);
  // Tracks whether the foreman deliberately changed the date. If he hasn't,
  // the date auto-follows "today" (including when the app returns to focus).
  const dateManual = useRef(false);
  // Tracks whether the foreman deliberately took himself out of the crew for
  // this card, so we don't keep auto-adding him back.
  const foremanRemoved = useRef(false);

  // ---- Hydrate persisted state on first load ----
  useEffect(() => {
    try {
      const savedLang = localStorage.getItem(LANG_KEY) as Lang | null;
      if (savedLang === "en" || savedLang === "es") setLang(savedLang);

      const savedForeman = localStorage.getItem(FOREMAN_KEY);
      if (savedForeman) setForeman(savedForeman);
      else setShowForemanPicker(true);

      const draftRaw = localStorage.getItem(DRAFT_KEY);
      if (draftRaw) {
        const d = JSON.parse(draftRaw);
        if (d.foremanRemoved) foremanRemoved.current = true;
        let restored: Worker[] = Array.isArray(d.workers) ? d.workers : [];
        if (savedForeman && !foremanRemoved.current) {
          restored = ensureForeman(savedForeman, restored);
        }
        const draftHasHours = restored.some((w) => w.hours != null && w.hours > 0);

        if (d.date) {
          if (d.date < todayISO()) {
            // Leftover draft from a previous day.
            if (draftHasHours) {
              // Real work on it — keep the old date but leave it UNCONFIRMED,
              // so Review asks "which day?" before submitting.
              setDate(d.date);
              staleUnconfirmed.current = true;
            } else {
              // Empty/abandoned — silently freshen to today, no interruption.
              setDate(todayISO());
            }
          } else {
            setDate(d.date);
            if (d.date !== todayISO()) dateManual.current = true;
          }
        }
        if (typeof d.job === "string") setJob(d.job);
        setWorkers(restored);
        if (typeof d.workDone === "string") setWorkDone(d.workDone);
        if (typeof d.notes === "string") setNotes(d.notes);
      } else {
        // No draft: prefill crew from last submitted crew, hours blank
        let initial: Worker[] = [];
        const lastRaw = localStorage.getItem(LASTCREW_KEY);
        if (lastRaw) {
          const last = JSON.parse(lastRaw) as string[];
          if (Array.isArray(last) && last.length) {
            initial = last.map((n) => ({ name: n, hours: null }));
          }
        }
        if (savedForeman) initial = ensureForeman(savedForeman, initial);
        setWorkers(initial);
      }
    } catch {
      /* ignore */
    }
    hydrated.current = true;
  }, []);

  // ---- Fetch roster (reusable, used on load and by the refresh button) ----
  const loadRoster = useCallback(async () => {
    try {
      const r = await fetch("/api/roster");
      const d = await r.json();
      if (Array.isArray(d.workers)) setRoster(d.workers);
      if (Array.isArray(d.foremen)) setForemen(d.foremen);
    } catch {
      /* ignore */
    } finally {
      setRosterLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  // Refresh the roster only (never touches the form). Brief spin + confirm.
  async function refreshRoster() {
    if (refreshing) return;
    setRefreshing(true);
    setJustUpdated(false);
    await loadRoster();
    setRefreshing(false);
    setJustUpdated(true);
    window.setTimeout(() => setJustUpdated(false), 1800);
  }

  // When the search box is focused, lift it toward the top so the matching
  // names stay visible above the on-screen keyboard. Fires a few times to ride
  // out the keyboard's open animation (iOS timing is inconsistent).
  function liftSearchBox() {
    const doScroll = () =>
      addBoxRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    window.setTimeout(doScroll, 150);
    window.setTimeout(doScroll, 400);
    window.setTimeout(doScroll, 650);
  }

  // ---- Re-check today's date whenever the app returns to focus ----
  // Foremen often leave the app open in the background overnight; this makes
  // sure the date is correct for the current day when they come back, unless
  // they deliberately picked a different date.
  useEffect(() => {
    function refresh() {
      if (!dateManual.current && submitState !== "sent") {
        setDate(todayISO());
      }
    }
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [submitState]);

  // ---- Persist draft whenever it changes ----
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          date,
          job,
          workers,
          workDone,
          notes,
          foremanRemoved: foremanRemoved.current,
        })
      );
    } catch {
      /* ignore */
    }
  }, [date, job, workers, workDone, notes]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  // ---- Derived ----
  const selectedNames = useMemo(
    () => new Set(workers.map((w) => w.name.toLowerCase())),
    [workers]
  );

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = roster.filter((n) => !selectedNames.has(n.toLowerCase()));
    if (!q) return pool.slice(0, 200);
    // Rank: names that start with the query come first, then the rest —
    // but every match is shown as an equal option (no single highlighted pick),
    // so common first names don't hide the person you actually want.
    const matches = pool.filter((n) => n.toLowerCase().includes(q));
    matches.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
    return matches.slice(0, 200);
  }, [query, roster, selectedNames]);

  const exactExists = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      roster.some((n) => n.toLowerCase() === q) ||
      workers.some((w) => w.name.toLowerCase() === q)
    );
  }, [query, roster, workers]);

  const total = useMemo(
    () => workers.reduce((s, w) => s + (w.hours || 0), 0),
    [workers]
  );

  // ---- Actions ----
  function addWorker(name: string, isNew = false) {
    const clean = name.trim();
    if (!clean) return;
    if (workers.some((w) => w.name.toLowerCase() === clean.toLowerCase())) {
      setQuery("");
      return;
    }
    setWorkers((prev) => [...prev, { name: clean, hours: null, isNew }]);
    setQuery("");
    // Only scroll if the add-worker box has been pushed out of view. When it's
    // already visible, leave the screen completely still (no jerk on rapid adds).
    requestAnimationFrame(() => {
      const el = addBoxRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const fullyVisible = rect.top >= 0 && rect.bottom <= vh;
      if (!fullyVisible) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  function removeWorker(name: string) {
    // Removing yourself (the foreman) asks for a quick confirm.
    if (foreman && name.toLowerCase() === foreman.toLowerCase()) {
      setSelfRemoveName(name);
      return;
    }
    setWorkers((prev) => prev.filter((w) => w.name !== name));
  }

  function confirmSelfRemove() {
    if (!selfRemoveName) return;
    foremanRemoved.current = true;
    setWorkers((prev) =>
      prev.filter((w) => w.name.toLowerCase() !== selfRemoveName.toLowerCase())
    );
    setSelfRemoveName(null);
  }

  function setWorkerHours(name: string, hours: number | null) {
    setWorkers((prev) =>
      prev.map((w) => (w.name === name ? { ...w, hours } : w))
    );
  }

  function applyAll(hours: number) {
    setWorkers((prev) => prev.map((w) => ({ ...w, hours })));
  }

  function chooseForeman(name: string) {
    const prev = foreman;
    setForeman(name);
    try {
      localStorage.setItem(FOREMAN_KEY, name);
    } catch {}
    foremanRemoved.current = false;
    setWorkers((list) => {
      let next = list;
      // On a clean swap, drop the old foreman if he was added but untouched.
      if (prev && prev.toLowerCase() !== name.toLowerCase()) {
        next = next.filter(
          (w) =>
            !(w.name.toLowerCase() === prev.toLowerCase() && w.hours == null)
        );
      }
      return ensureForeman(name, next);
    });
    setShowForemanPicker(false);
  }

  function validate(): string {
    if (!foreman) return tr.noForeman;
    if (!job.trim()) return tr.noJob;
    if (date > todayISO()) return tr.noFutureDate;
    if (workers.length === 0) return tr.noCrew;
    if (workers.some((w) => !w.hours || w.hours <= 0)) return tr.noHours;
    return "";
  }

  function goReview() {
    const msg = validate();
    if (msg) {
      setValidationMsg(msg);
      return;
    }
    // If the date came from a leftover previous-day draft and hasn't been
    // confirmed, ask "which day?" before showing the review screen.
    if (staleUnconfirmed.current && date !== todayISO()) {
      setValidationMsg("");
      setShowDatePrompt(true);
      return;
    }
    setValidationMsg("");
    setScreen("review");
  }

  async function submit() {
    setSubmitState("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          foreman,
          date,
          job: job.trim(),
          workDone: workDone.trim(),
          notes: notes.trim(),
          workers: workers.map((w) => ({
            name: w.name,
            hours: w.hours,
            isNew: !!w.isNew,
          })),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "fail");
      }
      // Success: remember crew, clear draft
      try {
        localStorage.setItem(
          LASTCREW_KEY,
          JSON.stringify(workers.map((w) => w.name))
        );
        localStorage.removeItem(DRAFT_KEY);
      } catch {}
      setSubmitState("sent");
    } catch (e: any) {
      setSubmitState("error");
      setErrorMsg(tr.failBody);
    }
  }

  function clearForm(keepDate = false) {
    setJob("");
    foremanRemoved.current = false;
    setWorkers(foreman ? ensureForeman(foreman, []) : []);
    setWorkDone("");
    setNotes("");
    setQuery("");
    if (!keepDate) {
      dateManual.current = false;
      setDate(todayISO());
    }
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
    setShowClearConfirm(false);
  }

  function logAnotherTimecard() {
    // After a successful submit: keep the crew, clear job + hours, and carry
    // the last-used date forward (so a Saturday batch flows day to day).
    // The carried date is session-only — a true cold start still defaults to
    // today, and an unfinished card is preserved as-is by the draft system.
    const last = workers.map((w) => w.name);
    setJob("");
    setWorkDone("");
    setNotes("");
    setQuery("");
    foremanRemoved.current = false;
    // Carry the current date forward; mark it manual so the focus re-check
    // doesn't snap it back to today during the batch.
    dateManual.current = true;
    let next = last.map((n) => ({ name: n, hours: null as number | null }));
    if (foreman) next = ensureForeman(foreman, next);
    setWorkers(next);
    setSubmitState("idle");
    setScreen("form");
  }

  function finishSession() {
    // The clean exit from the "Sent" screen: a fresh card, date back to today,
    // crew remembered for next time.
    const last = workers.map((w) => w.name);
    setJob("");
    setWorkDone("");
    setNotes("");
    setQuery("");
    dateManual.current = false;
    setDate(todayISO());
    foremanRemoved.current = false;
    let next = last.map((n) => ({ name: n, hours: null as number | null }));
    if (foreman) next = ensureForeman(foreman, next);
    setWorkers(next);
    setSubmitState("idle");
    setScreen("form");
  }

  // ---- Foreman picker (first-run / change) ----
  if (showForemanPicker) {
    return (
      <ForemanPicker
        roster={foremen}
        rosterLoaded={rosterLoaded}
        tr={tr}
        lang={lang}
        setLang={setLang}
        onPick={chooseForeman}
        current={foreman}
        onCancel={foreman ? () => setShowForemanPicker(false) : undefined}
      />
    );
  }

  // ---- Sent confirmation screen ----
  if (submitState === "sent") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <div className="text-safety text-6xl mb-4">✓</div>
        <h1 className="text-2xl font-bold mb-2">{tr.sent}</h1>
        <p className="text-rebar mb-10">{job}</p>
        <button
          onClick={logAnotherTimecard}
          className="w-full max-w-sm bg-safety text-steel font-bold py-4 rounded-2xl mb-3 active:bg-safetyDark"
        >
          {tr.logAnotherCard}
        </button>
        <button
          onClick={finishSession}
          className="w-full max-w-sm bg-graphite text-concrete font-semibold py-4 rounded-2xl"
        >
          {tr.done}
        </button>
      </div>
    );
  }

  // ---- Review screen ----
  if (screen === "review") {
    return (
      <div className="min-h-screen flex flex-col">
        <TopBar tr={tr} lang={lang} setLang={setLang} />
        <div className="flex-1 overflow-y-auto px-5 pb-32">
          <h2 className="text-xs font-bold text-rebar tracking-wide mt-4 mb-3">
            {tr.reviewTitle.toUpperCase()}
          </h2>

          {/* Date heads-up: only when the card isn't dated today. */}
          {date !== todayISO() && (
            <div className="mb-3 rounded-2xl bg-safety/25 border-2 border-safety px-4 py-3 flex items-start gap-2">
              <span className="text-safety text-xl leading-none mt-0.5">⚠</span>
              <span className="text-base font-bold text-concrete">
                {tr.dateNotToday.replace("{date}", friendlyDate(date, lang))}
              </span>
            </div>
          )}

          <div className="bg-concrete text-steel rounded-2xl p-5">
            <div className="text-lg font-bold">{job}</div>
            <div className="text-sm text-graphite/70 mb-4">
              {prettyDate(date, lang)} · {foreman}
            </div>
            <div className="flex justify-between text-[11px] font-bold text-graphite/50 border-b border-graphite/20 pb-1 mb-2">
              <span>{tr.workerHeader.toUpperCase()}</span>
              <span>{tr.hoursHeader.toUpperCase()}</span>
            </div>
            {workers.map((w) => (
              <button
                key={w.name}
                onClick={() => setScreen("form")}
                className="w-full flex justify-between py-2 border-b border-graphite/10 text-left active:bg-graphite/5"
              >
                <span className="font-medium">{w.name}</span>
                <span className="font-semibold tabular-nums">{w.hours}</span>
              </button>
            ))}
            <div className="flex justify-between items-center pt-3 mt-1 border-t border-graphite/20">
              <div>
                <div className="text-[11px] font-bold text-graphite/50">
                  {tr.workersCount.toUpperCase()}
                </div>
                <div className="text-2xl font-extrabold text-steel tabular-nums">
                  {workers.length}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] font-bold text-graphite/50">
                  {tr.total.toUpperCase()}
                </div>
                <div className="text-2xl font-extrabold text-safetyDark tabular-nums">
                  {round2(total)}
                </div>
              </div>
            </div>
            {workDone.trim() && (
              <div className="mt-4 text-sm">
                <div className="text-[11px] font-bold text-graphite/50">
                  {tr.workDone.toUpperCase()}
                </div>
                <div>{workDone}</div>
              </div>
            )}
            {notes.trim() && (
              <div className="mt-3 text-sm">
                <div className="text-[11px] font-bold text-graphite/50">
                  {tr.notes.toUpperCase()}
                </div>
                <div>{notes}</div>
              </div>
            )}
          </div>

          {submitState === "error" && (
            <div className="mt-4 bg-red-500/15 border border-red-500/40 rounded-2xl p-4 text-red-200">
              <div className="font-bold">{tr.failTitle}</div>
              <div className="text-sm">{errorMsg}</div>
            </div>
          )}
        </div>

        {/* Sticky bottom bar */}
        <div className="fixed bottom-0 inset-x-0 bg-steel border-t border-line p-4 flex gap-3">
          <button
            onClick={() => setScreen("form")}
            disabled={submitState === "submitting"}
            className="px-5 py-4 rounded-2xl bg-graphite text-concrete font-semibold disabled:opacity-50"
          >
            {tr.back}
          </button>
          <button
            onClick={submit}
            disabled={submitState === "submitting"}
            className="flex-1 py-4 rounded-2xl bg-safety text-steel text-lg font-extrabold active:bg-safetyDark disabled:opacity-60"
          >
            {submitState === "submitting" ? tr.submitting : tr.submit}
          </button>
        </div>
      </div>
    );
  }

  // ---- Main form ----
  // Proceed to the review screen once the date is settled.
  function proceedToReview() {
    staleUnconfirmed.current = false;
    setShowDatePrompt(false);
    setValidationMsg("");
    setScreen("review");
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Date check at Review — only when the date came from a leftover draft on
          a previous day and the worker hasn't confirmed it. Date-only buttons. */}
      {showDatePrompt && (
        <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-6">
          <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5 relative">
            <button
              onClick={() => setShowDatePrompt(false)}
              aria-label="Close"
              className="absolute top-3 right-3 w-8 h-8 rounded-full bg-steel border border-line text-rebar flex items-center justify-center active:text-safety"
            >
              ✕
            </button>
            <div className="text-concrete text-xl font-bold text-center mt-1 mb-5">
              {tr.staleTitle}
            </div>
            {/* Leftover draft date */}
            <button
              onClick={() => proceedToReview()}
              className="w-full bg-steel border border-line rounded-xl py-4 mb-3 text-concrete text-lg font-bold active:bg-black/30"
            >
              {friendlyDate(date, lang)}
            </button>
            {/* Today */}
            <button
              onClick={() => {
                setDate(todayISO());
                proceedToReview();
              }}
              className="w-full bg-safety text-steel rounded-xl py-4 mb-3 text-lg font-bold active:opacity-90"
            >
              {friendlyDate(todayISO(), lang)}
            </button>
            {/* Other date — close the prompt, scroll to the date field on the
                card and highlight it, so the worker changes it there (the field
                that already works reliably on every device). */}
            <button
              onClick={goToDateField}
              className="block w-full text-center text-rebar text-base font-semibold py-2.5 active:text-safety"
            >
              {tr.staleOtherDate} →
            </button>
          </div>
        </div>
      )}
      <TopBar
        tr={tr}
        lang={lang}
        setLang={setLang}
        onRefresh={refreshRoster}
        refreshing={refreshing}
        justUpdated={justUpdated}
        onMenu={() => setShowMenu(true)}
      />

      <div className="flex-1 overflow-y-auto px-5 pb-32">
        {/* Foreman line — only the Change button is tappable now */}
        <div className="w-full flex items-center justify-between mt-4 mb-5">
          <div>
            <div className="text-[11px] font-bold text-rebar tracking-wide">
              {tr.foreman.toUpperCase()}
            </div>
            <div className="text-lg font-bold">{foreman}</div>
          </div>
          <button
            onClick={() => setShowForemanPicker(true)}
            className="text-safety text-xs font-bold px-3 py-1.5 rounded-full border border-safety/60 active:bg-safety/10 shrink-0"
          >
            {tr.changeForeman}
          </button>
        </div>

        {/* Date + Job */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <Field label={tr.date}>
            <div ref={dateFieldRef}>
              <input
                type="date"
                value={date}
                max={todayISO()}
                onChange={(e) => {
                  dateManual.current = true;
                  staleUnconfirmed.current = false; // worker chose a date
                  setDate(e.target.value);
                }}
                className={`w-full min-w-0 box-border h-12 bg-graphite rounded-xl px-3 text-concrete appearance-none transition-all duration-300 ${
                  datePulse
                    ? "ring-4 ring-safety ring-offset-2 ring-offset-steel"
                    : "ring-0"
                }`}
              />
            </div>
          </Field>
          <Field label={tr.job}>
            <input
              type="text"
              value={job}
              onChange={(e) => setJob(e.target.value)}
              placeholder={tr.jobPlaceholder}
              className="w-full min-w-0 box-border h-12 bg-graphite rounded-xl px-3 text-concrete placeholder:text-rebar/60"
            />
          </Field>
        </div>

        {/* Crew */}
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-bold text-rebar tracking-wide">
            {tr.crew.toUpperCase()}
          </div>
          {workers.length > 1 && (
            <ApplyAll tr={tr} onApply={applyAll} />
          )}
        </div>

        {/* Selected workers with hours */}
        <div className="space-y-2 mb-3">
          {workers.map((w) => (
            <div
              key={w.name}
              className="bg-graphite rounded-2xl p-3 flex items-center gap-3"
            >
              <button
                onClick={() => removeWorker(w.name)}
                aria-label={tr.remove}
                className="text-rebar text-xl leading-none w-7 h-7 flex items-center justify-center rounded-full bg-steel/60"
              >
                ×
              </button>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{w.name}</div>
                {w.isNew && (
                  <div className="text-[10px] text-safety font-bold">
                    {lang === "es" ? "NUEVO" : "NEW"}
                  </div>
                )}
              </div>
              <HoursControl
                value={w.hours}
                onChange={(h) => setWorkerHours(w.name, h)}
                lang={lang}
              />
            </div>
          ))}
        </div>

        {/* Add / search box */}
        <div ref={addBoxRef} className="bg-graphite rounded-2xl p-2 scroll-mt-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              setSearchFocused(true);
              liftSearchBox();
            }}
            onBlur={() => setSearchFocused(false)}
            placeholder={tr.addWorkerSearch}
            className="w-full bg-transparent px-2 py-2 text-concrete placeholder:text-rebar/60 outline-none"
          />

          {(query.trim() || suggestions.length > 0) && (
            <div className="max-h-[46vh] overflow-y-auto mt-1">
              {/* Matching people first — all shown equally, none pre-picked */}
              {suggestions.map((n) => (
                <button
                  key={n}
                  onClick={() => addWorker(n)}
                  className="w-full text-left px-3 py-3 rounded-xl active:bg-steel/60 text-concrete border-b border-line/40 last:border-0"
                >
                  {n}
                </button>
              ))}

              {!rosterLoaded && (
                <div className="px-3 py-3 text-rebar text-sm">{tr.loading}</div>
              )}

              {/* Create-new option LAST, so it's never an accidental tap */}
              {!exactExists && query.trim() && (
                <button
                  onClick={() => addWorker(query, true)}
                  className="w-full text-left px-3 py-3 rounded-xl bg-safety/15 text-safety font-semibold mt-1"
                >
                  + {tr.addNew} “{query.trim()}”
                </button>
              )}
            </div>
          )}
        </div>

        {/* Work done + notes */}
        <div className="mt-5 space-y-4">
          <Field label={tr.workDone}>
            <textarea
              value={workDone}
              onChange={(e) => setWorkDone(e.target.value)}
              placeholder={tr.workDonePlaceholder}
              rows={2}
              className="w-full bg-graphite rounded-xl px-3 py-3 text-concrete placeholder:text-rebar/60 resize-none"
            />
          </Field>
          <Field label={tr.notes}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={tr.notesPlaceholder}
              rows={2}
              className="w-full bg-graphite rounded-xl px-3 py-3 text-concrete placeholder:text-rebar/60 resize-none"
            />
          </Field>
        </div>

        {/* Clear */}
        <button
          onClick={() => setShowClearConfirm(true)}
          className="mt-6 text-rebar text-sm font-semibold underline underline-offset-4"
        >
          {tr.clear}
        </button>
      </div>

      {/* Sticky review bar — hidden while searching so it doesn't float over
          the name list above the keyboard */}
      {!searchFocused && (
        <div className="fixed bottom-0 inset-x-0 bg-steel border-t border-line p-4">
          {validationMsg && (
            <div className="text-red-300 text-sm font-semibold mb-2 text-center">
              {validationMsg}
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="text-rebar text-sm">
              {tr.crewLabel}:{" "}
              <span className="text-concrete font-bold tabular-nums">
                {workers.length}
              </span>
              <span className="text-rebar/50 mx-2">|</span>
              {tr.total}:{" "}
              <span className="text-concrete font-bold tabular-nums">
                {round2(total)}
              </span>
            </div>
            <button
              onClick={goReview}
              className="px-8 py-4 rounded-2xl bg-safety text-steel text-lg font-extrabold active:bg-safetyDark"
            >
              {tr.review}
            </button>
          </div>
        </div>
      )}

      {/* Clear confirm */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center p-4 z-50">
          <div className="bg-graphite rounded-3xl p-6 w-full max-w-sm">
            <div className="font-bold text-lg mb-5">{tr.clearConfirm}</div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 py-4 rounded-2xl bg-steel text-concrete font-semibold"
              >
                {tr.no}
              </button>
              <button
                onClick={() => clearForm(false)}
                className="flex-1 py-4 rounded-2xl bg-safety text-steel font-bold"
              >
                {tr.yes}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Self-removal confirm (foreman taking himself off the crew) */}
      {selfRemoveName && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center p-4 z-50">
          <div className="bg-graphite rounded-3xl p-6 w-full max-w-sm">
            <div className="font-bold text-lg mb-5">{tr.selfRemoveConfirm}</div>
            <div className="flex gap-3">
              <button
                onClick={() => setSelfRemoveName(null)}
                className="flex-1 py-4 rounded-2xl bg-steel text-concrete font-semibold"
              >
                {tr.no}
              </button>
              <button
                onClick={confirmSelfRemove}
                className="flex-1 py-4 rounded-2xl bg-safety text-steel font-bold"
              >
                {tr.yes}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hamburger dropdown menu */}
      {showMenu && (
        <div
          className="fixed inset-0 z-[55] bg-black/40"
          onClick={() => {
            setShowMenu(false);
            setAdminPin("");
            setAdminPinError(false);
          }}
        >
          <div
            className="absolute top-16 left-4 bg-graphite rounded-2xl shadow-xl overflow-hidden min-w-[220px] border border-line"
            onClick={(e) => e.stopPropagation()}
          >
            {!adminUnlocked ? (
              // PIN entry — gates the whole admin area.
              <div className="p-5">
                <div className="text-concrete font-semibold mb-1">{tr.enterPin}</div>
                <div className="text-rebar text-xs mb-3">{tr.pinSubtitle}</div>
                <input
                  type="tel"
                  inputMode="numeric"
                  autoFocus
                  value={adminPin}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
                    setAdminPin(digits);
                    setAdminPinError(false);
                    if (digits.length === 4) {
                      if (digits === "5314") {
                        setAdminUnlocked(true);
                        setAdminPinError(false);
                      } else {
                        setAdminPinError(true);
                        setTimeout(() => setAdminPin(""), 350);
                      }
                    }
                  }}
                  placeholder="••••"
                  className={`w-full bg-steel rounded-xl px-4 h-12 text-concrete text-center tracking-[0.5em] text-xl ${
                    adminPinError ? "ring-2 ring-red-500" : ""
                  }`}
                />
              </div>
            ) : (
              <>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowReports(true);
                  }}
                  className="w-full text-left px-5 py-4 font-semibold text-concrete active:bg-steel flex items-center gap-3"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
                    <path d="M9 13h6M9 17h3" />
                  </svg>
                  {tr.reportsTitle}
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowSchedule(true);
                  }}
                  className="w-full text-left px-5 py-4 font-semibold text-concrete active:bg-steel flex items-center gap-3 border-t border-line"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path d="M16 2v4M8 2v4M3 10h18" />
                  </svg>
                  {tr.scheduleTitle}
                </button>
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowRecon(true);
                  }}
                  className="w-full text-left px-5 py-4 font-semibold text-concrete active:bg-steel flex items-center gap-3 border-t border-line"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  {tr.reconTitle}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Reports admin panel */}
      {showReports && (
        <ReportsPanel
          tr={tr}
          unlockedPin={adminUnlocked ? "5314" : ""}
          onClose={() => setShowReports(false)}
        />
      )}

      {/* Schedule panel */}
      {showSchedule && (
        <SchedulePanel
          tr={tr}
          pin={adminUnlocked ? "5314" : ""}
          onClose={() => setShowSchedule(false)}
        />
      )}

      {/* Reconciliation panel */}
      {showRecon && (
        <ReconPanel
          tr={tr}
          lang={lang}
          onClose={() => setShowRecon(false)}
        />
      )}
    </div>
  );
}

// ---------- Subcomponents ----------

function TopBar({
  tr,
  lang,
  setLang,
  onRefresh,
  refreshing,
  justUpdated,
  onMenu,
}: {
  tr: ReturnType<typeof t>;
  lang: Lang;
  setLang: (l: Lang) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  justUpdated?: boolean;
  onMenu?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 pt-5 pb-2">
      <div className="flex items-center gap-2">
        {onMenu && (
          <button
            onClick={onMenu}
            aria-label="Menu"
            className="w-9 h-9 rounded-lg bg-graphite text-concrete flex items-center justify-center mr-1"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        )}
        <div className="w-2.5 h-6 bg-safety rounded-sm" />
        <span className="font-extrabold tracking-tight">{tr.appTitle}</span>
      </div>
      <div className="flex items-center gap-2">
        {justUpdated && (
          <span className="text-xs font-bold text-safety">{tr.updated}</span>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            aria-label={tr.refresh}
            className="bg-graphite w-9 h-9 rounded-full text-concrete flex items-center justify-center"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        )}
        <button
          onClick={() => setLang(lang === "es" ? "en" : "es")}
          className="text-xs font-bold bg-graphite px-3 py-2 rounded-full text-concrete"
        >
          {lang === "es" ? "EN" : "ES"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <div className="text-[11px] font-bold text-rebar tracking-wide mb-1">
        {label.toUpperCase()}
      </div>
      {children}
    </label>
  );
}

function fmtShort(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}`;
}

function weekOptions(): { iso: string; label: string }[] {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const today = new Date(now.getTime() - off * 60000);
  const dow = today.getUTCDay();
  // Week runs Monday..Sunday. Find this week's Monday.
  const backToMonday = (dow + 6) % 7;
  const thisMon = new Date(today);
  thisMon.setUTCDate(thisMon.getUTCDate() - backToMonday);
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const mk = (weeksBack: number, name: string) => {
    const s = new Date(thisMon);
    s.setUTCDate(s.getUTCDate() - 7 * weeksBack);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 6);
    return {
      iso: s.toISOString().slice(0, 10),
      label: `${name} (${fmt(s)} – ${fmt(e)})`,
    };
  };
  // This week first (default), then last week. Recomputed every open.
  return [mk(0, "This week"), mk(1, "Last week")];
}

function ReportsPanel({
  tr,
  onClose,
  unlockedPin = "",
}: {
  tr: ReturnType<typeof t>;
  onClose: () => void;
  unlockedPin?: string;
}) {
  const [pin, setPin] = useState(unlockedPin);
  const [pinOk, setPinOk] = useState(unlockedPin === "5314");
  const [pinError, setPinError] = useState(false);

  const weeks = useMemo(() => weekOptions(), []);
  const [weekStart, setWeekStart] = useState(weeks[0]?.iso || "");
  const thisWeekStart = weeks[0]?.iso || "";
  const thisWeekEnd = useMemo(() => {
    if (!thisWeekStart) return "";
    const [y, m, d] = thisWeekStart.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 6));
    return dt.toISOString().slice(0, 10);
  }, [thisWeekStart]);
  const [customStart, setCustomStart] = useState(thisWeekStart);
  const [customEnd, setCustomEnd] = useState(thisWeekEnd);
  const [flagsOn, setFlagsOn] = useState(true);
  const [foremen, setForemen] = useState<string[]>([]);
  const [foreman, setForeman] = useState(""); // "" = All
  const [reportType, setReportType] = useState<
    "job" | "worker" | "daily" | "payrollGrid" | "foreman"
  >("job");
  const [lang, setLang] = useState<"en" | "es">("en");
  const [langTouched, setLangTouched] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [resultMsg, setResultMsg] = useState("");
  const [debugText, setDebugText] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugCopied, setDebugCopied] = useState(false);

  // Load the foreman list once the panel is unlocked.
  useEffect(() => {
    if (!pinOk) return;
    let alive = true;
    fetch("/api/roster")
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.foremen)) setForemen(d.foremen);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pinOk]);

  // Auto-suggest language: Spanish for a foreman report (it's for them),
  // English for the master/worker reports — unless the user set it manually.
  function onReportTypeChange(
    v: "job" | "worker" | "daily" | "payrollGrid" | "foreman"
  ) {
    setReportType(v);
    if (!langTouched) setLang(v === "foreman" ? "es" : "en");
  }

  function onForemanChange(v: string) {
    setForeman(v);
  }

  function onPinChange(v: string) {
    const digits = v.replace(/\D/g, "").slice(0, 4);
    setPin(digits);
    setPinError(false);
    if (digits.length === 4) {
      if (digits === "5314") {
        setPinOk(true);
        setPinError(false);
      } else {
        setPinError(true);
        setTimeout(() => setPin(""), 350);
      }
    }
  }

  function reqBody(mode: "view" | "email") {
    const base: any = {
      pin,
      flags: flagsOn,
      lang,
      mode,
      // Map the report type to the backend's foreman + reportView params.
      foreman: reportType === "foreman" ? foreman : "",
      reportView:
        reportType === "worker"
          ? "worker"
          : reportType === "daily"
          ? "daily"
          : reportType === "payrollGrid"
          ? "payrollGrid"
          : reportType === "foreman" && !foreman
          ? "foremanAll" // foreman report with "All" → per-foreman breakout
          : "job",
    };
    if (weekStart === "custom") {
      base.startISO = customStart;
      base.endISO = customEnd;
    } else {
      base.weekStart = weekStart;
    }
    return base;
  }

  async function sharePdf(b64: string, filename: string) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      // On touch devices (iPhone/iPad) the native share sheet is the natural
      // way to handle a file. On desktop (Mac/PC) that share sheet is a
      // nuisance for a "view" action, so just open the PDF in a new tab.
      const isTouch =
        typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 0;

      if (isTouch) {
        const nav: any = navigator;
        const file = new File([blob], filename, { type: "application/pdf" });
        if (nav.canShare && nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: filename });
          URL.revokeObjectURL(url);
          return;
        }
      }

      // Desktop (and any non-shareable case): open the PDF to review it.
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      /* sharing/opening may be blocked; ignore */
    }
  }

  async function generate(mode: "view" | "email") {
    setState("sending");
    setResultMsg("");
    setDebugText("");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody(mode)),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "fail");
      setState("sent");
      setResultMsg(
        `${d.jobs} job(s), ${d.unassigned} unassigned, ${d.noHours} no-hours, ${d.flags} flag(s)`
      );
      if (d.debug) setDebugText(JSON.stringify(d.debug, null, 2));
      if (mode === "view" && d.pdfBase64) {
        await sharePdf(d.pdfBase64, d.filename || "Ammex_Payroll.pdf");
      }
    } catch (e: any) {
      setState("error");
      setResultMsg(e?.message || "");
    }
  }

  // ---- PIN gate: compact popup anchored near the top ----
  if (!pinOk) {
    return (
      <div
        className="fixed inset-0 bg-black/60 z-[60] flex items-start justify-center px-4 pt-20"
        onClick={onClose}
      >
        <div
          className="bg-graphite rounded-3xl p-6 w-full max-w-sm relative"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            aria-label={tr.close}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-steel text-rebar flex items-center justify-center text-lg font-bold"
          >
            ✕
          </button>
          <div className="text-[11px] font-bold text-rebar tracking-wide mb-4 mt-1">
            {tr.enterPin.toUpperCase()}
          </div>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => onPinChange(e.target.value)}
            className="w-full text-center text-3xl tracking-[0.5em] bg-steel rounded-2xl py-4 text-concrete"
            placeholder="••••"
          />
          {pinError && (
            <div className="text-red-300 text-sm font-semibold mt-3 text-center">
              {tr.wrongPin}
            </div>
          )}
          <button
            onClick={onClose}
            className="mt-5 w-full py-4 rounded-2xl bg-steel text-concrete font-bold"
          >
            {tr.close}
          </button>
        </div>
      </div>
    );
  }

  // ---- Unlocked: the Reports panel ----
  return (
    <div className="fixed inset-0 bg-steel z-[60] flex flex-col">
      <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-line">
        <span className="font-extrabold text-lg">{tr.reportsTitle}</span>
        <button
          onClick={onClose}
          className="text-rebar text-sm font-bold bg-graphite px-3 py-2 rounded-full"
        >
          {tr.close}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
        <Field label={tr.weekLabel}>
          <select
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
            className="w-full bg-graphite rounded-xl px-3 h-12 text-concrete"
          >
            {weeks.map((w) => (
              <option key={w.iso} value={w.iso}>
                {w.label}
              </option>
            ))}
            <option value="custom">{tr.customRange}</option>
          </select>
        </Field>

        {weekStart === "custom" && (
          <div className="space-y-4">
            <Field label={tr.fromLabel}>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="appearance-none block w-full box-border bg-graphite rounded-xl px-3 h-12 text-concrete text-left"
              />
            </Field>
            <Field label={tr.toLabel}>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="appearance-none block w-full box-border bg-graphite rounded-xl px-3 h-12 text-concrete text-left"
              />
              {customStart && (
                <div className="text-[11px] text-rebar mt-1">
                  {tr.fromLabel} {fmtShort(customStart)}
                </div>
              )}
            </Field>
          </div>
        )}

        <Field label={tr.reportTypeLabel}>
          <select
            value={reportType}
            onChange={(e) =>
              onReportTypeChange(
                e.target.value as
                  | "job"
                  | "worker"
                  | "daily"
                  | "payrollGrid"
                  | "foreman"
              )
            }
            className="w-full bg-graphite rounded-xl px-3 h-12 text-concrete"
          >
            <option value="job">{tr.reportTypeJob}</option>
            <option value="worker">{tr.reportTypeWorker}</option>
            <option value="daily">{tr.reportTypeDaily}</option>
            <option value="payrollGrid">{tr.reportTypePayrollGrid}</option>
            <option value="foreman">{tr.reportTypeForeman}</option>
          </select>
        </Field>

        {reportType === "foreman" && (
          <Field label={tr.foremanLabel}>
            <select
              value={foreman}
              onChange={(e) => onForemanChange(e.target.value)}
              className="w-full bg-graphite rounded-xl px-3 h-12 text-concrete"
            >
              <option value="">{tr.allForemen}</option>
              {foremen.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="flex items-center justify-between bg-graphite rounded-xl px-4 py-3">
          <span className="font-semibold">{tr.reportLanguage}</span>
          <div className="flex bg-steel rounded-full p-1">
            <button
              onClick={() => {
                setLang("en");
                setLangTouched(true);
              }}
              className={`px-3 py-1 rounded-full text-sm font-bold ${
                lang === "en" ? "bg-safety text-steel" : "text-rebar"
              }`}
            >
              EN
            </button>
            <button
              onClick={() => {
                setLang("es");
                setLangTouched(true);
              }}
              className={`px-3 py-1 rounded-full text-sm font-bold ${
                lang === "es" ? "bg-safety text-steel" : "text-rebar"
              }`}
            >
              ES
            </button>
          </div>
        </div>

        <button
          onClick={() => setFlagsOn((f) => !f)}
          className="w-full flex items-center justify-between bg-graphite rounded-xl px-4 py-3"
        >
          <span className="font-semibold">{tr.includeFlags}</span>
          <span
            className={`w-12 h-7 rounded-full flex items-center px-1 transition ${
              flagsOn ? "bg-safety justify-end" : "bg-steel justify-start"
            }`}
          >
            <span className="w-5 h-5 rounded-full bg-concrete" />
          </span>
        </button>

        <button
          onClick={() => generate("view")}
          disabled={state === "sending"}
          className="w-full py-4 rounded-2xl bg-safety text-steel text-lg font-extrabold active:bg-safetyDark disabled:opacity-60"
        >
          {state === "sending" ? tr.generating : tr.generateView}
        </button>
        <button
          onClick={() => generate("email")}
          disabled={state === "sending"}
          className="w-full py-3.5 rounded-2xl bg-graphite text-concrete font-bold active:bg-steel disabled:opacity-60"
        >
          {tr.generateSend}
        </button>

        {state === "sent" && (
          <div className="bg-safety/15 border border-safety/40 rounded-2xl p-4">
            <div className="font-bold text-safety">{tr.reportSent}</div>
            <div className="text-sm text-rebar mt-1">{resultMsg}</div>
          </div>
        )}
        {debugText && (
          <div className="bg-graphite rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2.5">
              <button
                onClick={() => setDebugOpen((o) => !o)}
                className="flex items-center gap-2 text-[11px] font-bold text-rebar tracking-wide"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${debugOpen ? "rotate-90" : ""}`}
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                DIAGNOSTIC
              </button>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(debugText);
                  } catch {
                    /* clipboard may be blocked; the expanded box is selectable */
                  }
                  setDebugCopied(true);
                  setTimeout(() => setDebugCopied(false), 1500);
                }}
                className="text-[11px] font-bold bg-steel text-concrete px-3 py-1.5 rounded-full"
              >
                {debugCopied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            {debugOpen && (
              <textarea
                readOnly
                value={debugText}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full h-56 bg-steel rounded-b-xl p-3 text-[11px] text-concrete font-mono"
              />
            )}
          </div>
        )}
        {state === "error" && (
          <div className="bg-red-500/15 border border-red-500/40 rounded-2xl p-4 text-red-200">
            <div className="font-bold">{tr.reportFail}</div>
            {resultMsg && <div className="text-sm mt-1">{resultMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Schedule ----------

interface SchedJob {
  jobPageId: string;
  name: string;
  jobId: string;
  crew: { worker: string; isLead: boolean }[];
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function SchedulePanel({
  tr,
  pin,
  onClose,
}: {
  tr: ReturnType<typeof t>;
  pin: string;
  onClose: () => void;
}) {
  const [date, setDate] = useState(tomorrowISO());
  const [jobs, setJobs] = useState<SchedJob[]>([]);
  const [roster, setRoster] = useState<string[]>([]);
  const [availJobs, setAvailJobs] = useState<
    { id: string; name: string; jobId: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [showJobPicker, setShowJobPicker] = useState(false);
  const [jobQuery, setJobQuery] = useState("");
  const [workerFor, setWorkerFor] = useState<string | null>(null); // jobPageId
  const [workerQuery, setWorkerQuery] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<"idle" | "saved" | "error">("idle");
  const [resultMsg, setResultMsg] = useState("");
  const [kbOpen, setKbOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const newJobRef = useRef<HTMLDivElement>(null);
  const jobSearchRef = useRef<HTMLInputElement>(null);
  const workerSearchRef = useRef<HTMLInputElement>(null);

  // Remember the working state between sessions: restore the last date + jobs
  // on open, and re-save whenever they change. So closing the app and coming
  // back leaves the screen exactly as you left it.
  const DRAFT_KEY = "ammex_schedule_state_v1";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.date) setDate(saved.date);
        if (Array.isArray(saved?.jobs)) setJobs(saved.jobs);
      }
    } catch {}
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return; // don't overwrite before we've restored
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ date, jobs }));
    } catch {}
  }, [date, jobs, restored]);

  // Hide the sticky review bar while the on-screen keyboard is up (it otherwise
  // overlaps the search). Detected via the visual viewport shrinking.
  useEffect(() => {
    const vv = (typeof window !== "undefined" && window.visualViewport) || null;
    if (!vv) return;
    const onResize = () => {
      setKbOpen(window.innerHeight - vv.height > 150);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // Load roster + available jobs (re-runnable via the Refresh button so newly
  // added Notion jobs/workers show up without reopening).
  const [refreshing, setRefreshing] = useState(false);
  function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    return Promise.all([
      fetch("/api/roster").then((r) => r.json()).catch(() => ({})),
      fetch("/api/schedule-jobs").then((r) => r.json()).catch(() => ({})),
    ]).then(([rosterData, jobsData]) => {
      if (Array.isArray(rosterData?.workers)) setRoster(rosterData.workers);
      if (Array.isArray(jobsData?.jobs)) setAvailJobs(jobsData.jobs);
      setLoading(false);
      setRefreshing(false);
    });
  }
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function carryOver() {
    fetch("/api/schedule?recent=1")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.jobs) && d.jobs.length > 0) {
          setJobs(
            d.jobs.map((j: any) => ({
              jobPageId: j.jobPageId,
              name: j.name,
              jobId: j.jobId,
              // Lead first, then the rest — so the foreman shows on top.
              crew: [...(j.crew || [])].sort(
                (a: any, b: any) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0)
              ),
            }))
          );
        } else {
          setResultMsg("No previous schedule found to carry over.");
          setTimeout(() => setResultMsg(""), 3000);
        }
      })
      .catch(() => {});
  }

  function addJob(j: { id: string; name: string; jobId: string }) {
    if (jobs.some((x) => x.jobPageId === j.id)) {
      setJobQuery("");
      return;
    }
    // New job lands at the END of the sequence (right on iPad, bottom on phone),
    // matching the left-to-right flow of the paper schedule.
    setJobs((prev) => [
      ...prev,
      { jobPageId: j.id, name: j.name, jobId: j.jobId, crew: [] },
    ]);
    // Stay open for adding several jobs in a row; the picked job drops off the
    // list. Clear the search and keep the cursor in the box so you can keep
    // typing the next one without re-clicking.
    setJobQuery("");
    jobSearchRef.current?.focus();
    requestAnimationFrame(() =>
      newJobRef.current?.scrollIntoView({
        block: "nearest",
        inline: "end",
        behavior: "smooth",
      })
    );
  }

  function removeJob(jobPageId: string) {
    setJobs((prev) => prev.filter((j) => j.jobPageId !== jobPageId));
  }

  function addWorker(jobPageId: string, name: string) {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.jobPageId !== jobPageId) return j;
        if (j.crew.some((c) => c.worker === name)) return j;
        return { ...j, crew: [...j.crew, { worker: name, isLead: false }] };
      })
    );
    // Clear search and keep the cursor in the box for rapid multi-add.
    setWorkerQuery("");
    workerSearchRef.current?.focus();
  }

  function removeWorker(jobPageId: string, name: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.jobPageId === jobPageId
          ? { ...j, crew: j.crew.filter((c) => c.worker !== name) }
          : j
      )
    );
  }

  function setLead(jobPageId: string, name: string) {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.jobPageId !== jobPageId) return j;
        const crew = j.crew.map((c) => ({ ...c, isLead: c.worker === name }));
        // Keep the lead on top.
        crew.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
        return { ...j, crew };
      })
    );
  }

  // Which jobs (other than this one) a worker is already on, for the warning.
  function otherJobs(name: string, exceptJobId: string): string[] {
    return jobs
      .filter((j) => j.jobPageId !== exceptJobId && j.crew.some((c) => c.worker === name))
      .map((j) => j.name);
  }

  const totalCrew = jobs.reduce((s, j) => s + j.crew.length, 0);

  async function save() {
    setSaving(true);
    setResult("idle");
    const assignments: any[] = [];
    for (const j of jobs) {
      for (const c of j.crew) {
        assignments.push({
          worker: c.worker,
          jobPageId: j.jobPageId,
          jobName: j.name,
          jobId: j.jobId,
          isLead: c.isLead,
        });
      }
    }
    try {
      const resp = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, date, assignments }),
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        setResult("saved");
      } else {
        setResult("error");
        setResultMsg(data.error || "Save failed.");
      }
    } catch (e: any) {
      setResult("error");
      setResultMsg(e?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // Review screen
  if (showReview) {
    const warnings: string[] = [];
    for (const j of jobs) {
      if (!j.crew.some((c) => c.isLead) && j.crew.length > 0)
        warnings.push(`${j.name}: no foreman marked`);
    }
    const seen = new Map<string, number>();
    for (const j of jobs)
      for (const c of j.crew) seen.set(c.worker, (seen.get(c.worker) || 0) + 1);
    for (const [w, n] of seen) if (n > 1) warnings.push(`${w} is on ${n} jobs today`);

    return (
      <div className="fixed inset-0 z-[60] bg-steel overflow-y-auto">
        <div className="max-w-2xl mx-auto p-5 pb-32">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => setShowReview(false)} className="text-rebar font-semibold">
              ← Back to edit
            </button>
            <div className="text-rebar text-sm">{prettyScheduleDate(date)}</div>
          </div>

          {result === "saved" ? (
            <div className="text-center py-16">
              <div className="text-safety text-5xl mb-4">✓</div>
              <div className="text-concrete text-xl font-bold mb-2">Schedule saved</div>
              <div className="text-rebar mb-8">
                Saved to Notion and emailed for {prettyScheduleDate(date)}.
              </div>
              <button
                onClick={() => {
                  // Return to the Schedule builder (not out to the timesheet).
                  setResult("idle");
                  setShowReview(false);
                }}
                className="bg-safety text-steel font-bold rounded-xl px-8 py-3"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-concrete text-2xl font-bold mb-1">Review schedule</h2>
              <div className="text-rebar mb-5">
                {jobs.length} jobs · {totalCrew} crew
              </div>

              {warnings.length > 0 && (
                <div className="bg-[#3a2a18] border border-safety/40 rounded-xl p-4 mb-5">
                  <div className="text-safety font-semibold mb-2 text-sm">Heads up</div>
                  {warnings.map((w, i) => (
                    <div key={i} className="text-concrete/90 text-sm">• {w}</div>
                  ))}
                </div>
              )}

              <div className="space-y-4 mb-6">
                {jobs.map((j) => {
                  const lead = j.crew.find((c) => c.isLead);
                  const others = j.crew.filter((c) => !c.isLead);
                  return (
                    <div key={j.jobPageId} className="bg-graphite rounded-2xl p-4 border border-line">
                      <div className="text-concrete font-bold">
                        {j.name} {j.jobId && <span className="text-rebar text-sm">({j.jobId})</span>}
                      </div>
                      <div className="border-b border-line my-2" />
                      {lead && (
                        <div className="text-blue-400 font-semibold text-sm">
                          Foreman: {lead.worker.toUpperCase()}
                        </div>
                      )}
                      {others.map((c) => (
                        <div key={c.worker} className="text-concrete/90 text-sm ml-2">
                          {c.worker.toUpperCase()}
                        </div>
                      ))}
                      {j.crew.length === 0 && (
                        <div className="text-rebar text-sm">(no crew)</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {result === "error" && (
                <div className="text-red-400 text-sm mb-4">{resultMsg}</div>
              )}

              <button
                onClick={save}
                disabled={saving || totalCrew === 0}
                className="w-full bg-safety text-steel font-bold rounded-xl py-4 text-lg disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save to Notion & Email"}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Main builder screen
  const filteredRoster = (jobPageId: string) => {
    const onJob = new Set(
      jobs.find((j) => j.jobPageId === jobPageId)?.crew.map((c) => c.worker) || []
    );
    const q = workerQuery.trim().toLowerCase();
    return roster
      .filter((n) => !onJob.has(n))
      .filter((n) => !q || n.toLowerCase().includes(q));
  };
  const filteredJobs = () => {
    const q = jobQuery.trim().toLowerCase();
    const onBoard = new Set(jobs.map((j) => j.jobPageId));
    return availJobs
      .filter((j) => !onBoard.has(j.id))
      .filter((j) => !q || j.name.toLowerCase().includes(q) || j.jobId.toLowerCase().includes(q));
  };

  return (
    <div
      className={`fixed inset-0 z-[60] bg-steel ${
        showJobPicker || workerFor !== null ? "overflow-hidden" : "overflow-y-auto"
      }`}
    >
      <div className="max-w-7xl mx-auto p-4 pb-28">
        {/* Header — Close on the right to match the rest of the app */}
        {/* Header — Refresh + title + Close, as circular icon pills to match
            the rest of the app */}
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            aria-label="Refresh"
            className="w-9 h-9 rounded-full bg-graphite border border-line text-rebar flex items-center justify-center active:text-safety disabled:opacity-50"
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <div className="font-bold text-concrete text-lg">{tr.scheduleTitle}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full bg-graphite border border-line text-rebar flex items-center justify-center text-lg active:text-safety"
          >
            ✕
          </button>
        </div>

        {/* Controls — wrap instead of overflowing. All inline on iPad; on a
            narrow phone the actions wrap to the next line (never off-screen). */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-graphite border border-line rounded-full px-4 h-10 text-concrete text-sm w-[150px] shrink-0"
          />
          <button
            onClick={carryOver}
            className="bg-graphite border border-line rounded-full px-4 h-10 text-concrete font-semibold text-sm inline-flex items-center gap-1.5 active:text-safety shrink-0"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Carry over
          </button>
          {jobs.length > 0 && (
            <button
              onClick={() => setJobs([])}
              className="text-rebar border border-line rounded-full px-4 h-10 text-sm active:text-safety shrink-0"
            >
              Clear all
            </button>
          )}
        </div>

        {resultMsg && !showReview && (
          <div className="text-rebar text-sm mb-2">{resultMsg}</div>
        )}

        {/* Add job — on top */}
        <button
          onClick={() => setShowJobPicker(true)}
          className="w-full border border-dashed border-line rounded-2xl py-4 text-safety font-bold mb-4 active:bg-graphite"
        >
          + Add job
        </button>

        {loading && <div className="text-rebar text-center py-8">Loading…</div>}

        {/* Job cards — vertical stack on phone, horizontal scrolling row on
            iPad/desktop (jobs side by side in the order added, scroll across). */}
        <div className="flex flex-col md:flex-row md:overflow-x-auto gap-4 md:pb-3 md:-mx-1 md:px-1">
          {jobs.map((j, idx) => (
            <div
              key={j.jobPageId}
              ref={idx === jobs.length - 1 ? newJobRef : undefined}
              className="bg-graphite rounded-2xl p-4 border border-line w-full md:w-[330px] md:flex-shrink-0 md:self-start"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-concrete">{j.name}</div>
                  <div className="text-rebar text-xs">Job ID: {j.jobId || "—"}</div>
                </div>
                <button
                  onClick={() => removeJob(j.jobPageId)}
                  className="text-rebar text-lg px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <div className="text-rebar text-xs mt-1 mb-2">{j.crew.length} crew</div>

              <div className="space-y-1.5">
                {j.crew.map((c) => (
                  <div
                    key={c.worker}
                    onClick={() => setLead(j.jobPageId, c.worker)}
                    className={`flex items-center gap-2 bg-steel rounded-xl px-3 py-2.5 border ${
                      c.isLead ? "border-blue-500" : "border-transparent"
                    }`}
                  >
                    <span className="flex-1 text-concrete text-sm">{c.worker}</span>
                    {c.isLead && (
                      <span className="bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">
                        Lead
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeWorker(j.jobPageId, c.worker);
                      }}
                      className="text-rebar"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {/* Add worker — opens a modal picker (search on top, list below) */}
              <button
                onClick={() => {
                  setWorkerFor(j.jobPageId);
                  setWorkerQuery("");
                }}
                className="mt-2 w-full border border-dashed border-line rounded-xl py-2.5 text-rebar text-sm active:text-safety"
              >
                + Add worker
              </button>
            </div>
          ))}
        </div>

        {!loading && jobs.length === 0 && (
          <div className="text-rebar text-center py-10">
            Tap “Add job” to start, or “Carry over last”.
          </div>
        )}
      </div>

      {/* Job picker modal */}
      {showJobPicker && (
        <div
          className="fixed inset-0 z-[65] bg-black/50 flex items-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => setShowJobPicker(false)}
        >
          <div
            className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[75vh] sm:rounded-2xl border border-line overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sticky header: title + close, then the search box stays on top */}
            <div className="p-4 pb-2 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <div className="text-concrete font-bold">Add job</div>
                <button
                  onClick={() => {
                    setShowJobPicker(false);
                    setJobQuery("");
                  }}
                  aria-label="Close"
                  className="text-rebar text-xl leading-none px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <input
                ref={jobSearchRef}
                value={jobQuery}
                onChange={(e) => setJobQuery(e.target.value)}
                placeholder="Search active jobs…"
                className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
              />
            </div>
            {/* Scrollable list below the fixed search box */}
            <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
              {filteredJobs().map((j) => (
                <button
                  key={j.id}
                  onClick={() => addJob(j)}
                  className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete flex items-center justify-between"
                >
                  <span>{j.name}</span>
                  <span className="text-rebar text-sm">{j.jobId}</span>
                </button>
              ))}
              {filteredJobs().length === 0 && (
                <div className="text-rebar text-sm px-3 py-3">No active jobs match.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Worker picker modal — search on top, list below, multi-add */}
      {workerFor !== null && (
        <div
          className="fixed inset-0 z-[65] bg-black/50 flex items-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => {
            setWorkerFor(null);
            setWorkerQuery("");
          }}
        >
          <div
            className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[75vh] sm:rounded-2xl border border-line overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 pb-2 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <div className="text-concrete font-bold truncate pr-2">
                  Add worker{" "}
                  <span className="text-rebar font-normal">
                    · {jobs.find((j) => j.jobPageId === workerFor)?.name || ""}
                  </span>
                </div>
                <button
                  onClick={() => {
                    setWorkerFor(null);
                    setWorkerQuery("");
                  }}
                  aria-label="Close"
                  className="text-rebar text-xl leading-none px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <input
                ref={workerSearchRef}
                value={workerQuery}
                onChange={(e) => setWorkerQuery(e.target.value)}
                placeholder="Search worker…"
                className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
              />
            </div>
            <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
              {filteredRoster(workerFor).map((n) => {
                const elsewhere = otherJobs(n, workerFor);
                return (
                  <button
                    key={n}
                    onClick={() => addWorker(workerFor, n)}
                    className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete flex items-center justify-between"
                  >
                    <span>{n}</span>
                    {elsewhere.length > 0 && (
                      <span className="text-safety text-[11px]">
                        on {elsewhere.join(", ")}
                      </span>
                    )}
                  </button>
                );
              })}
              {filteredRoster(workerFor).length === 0 && (
                <div className="text-rebar text-sm px-3 py-3">No matches</div>
              )}
            </div>
          </div>
        </div>
      )}
      {jobs.length > 0 && !kbOpen && (
        <div
          className="fixed bottom-0 left-0 right-0 bg-graphite/95 border-t border-line backdrop-blur z-[62]"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <div className="max-w-7xl mx-auto flex items-center gap-3 px-4 pt-3">
            <div className="text-rebar text-sm whitespace-nowrap">
              {jobs.length} jobs · {totalCrew} crew
            </div>
            <button
              onClick={() => setShowReview(true)}
              className="ml-auto bg-safety text-steel font-bold rounded-xl px-6 py-2.5 whitespace-nowrap"
            >
              Review schedule →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function prettyScheduleDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${days[dt.getUTCDay()]}, ${mons[m - 1]} ${d}, ${y}`;
}

function HoursControl({
  value,
  onChange,
  lang,
}: {
  value: number | null;
  onChange: (h: number | null) => void;
  lang: Lang;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(value != null ? String(value) : "");

  useEffect(() => {
    setRaw(value != null ? String(value) : "");
  }, [value]);

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        inputMode="decimal"
        step="0.25"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseFloat(raw);
          onChange(isNaN(n) ? null : n);
          setEditing(false);
        }}
        className="w-20 text-center bg-steel rounded-xl py-2 font-bold text-concrete"
      />
    );
  }

  return (
    <div className="flex items-center gap-1">
      <div className="hidden">{lang}</div>
      {QUICK_HOURS.map((h) => (
        <button
          key={h}
          onClick={() => onChange(h)}
          className={`w-9 h-10 rounded-lg text-sm font-bold ${
            value === h
              ? "bg-safety text-steel"
              : "bg-steel/70 text-rebar"
          }`}
        >
          {h}
        </button>
      ))}
      <button
        onClick={() => setEditing(true)}
        className={`min-w-[2.75rem] h-10 px-2 rounded-lg text-sm font-bold ${
          value != null && !QUICK_HOURS.includes(value)
            ? "bg-safety text-steel"
            : "bg-steel/70 text-concrete"
        }`}
      >
        {value != null && !QUICK_HOURS.includes(value) ? value : "·.·"}
      </button>
    </div>
  );
}

function ApplyAll({
  tr,
  onApply,
}: {
  tr: ReturnType<typeof t>;
  onApply: (h: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("8");

  function confirm() {
    const n = parseFloat(raw);
    if (!isNaN(n)) onApply(n);
    setOpen(false);
  }

  return (
    <>
      <button
        onClick={() => {
          setRaw("8");
          setOpen(true);
        }}
        className="text-safety text-xs font-bold px-3 py-1.5 rounded-full border border-safety/60 active:bg-safety/10"
      >
        {tr.applyAll}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xs bg-graphite rounded-3xl p-5 shadow-2xl border border-safety/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-bold text-concrete">
                {tr.applyAllTitle}
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="w-8 h-8 -mr-1 flex items-center justify-center rounded-full bg-steel/70 text-rebar text-lg active:bg-steel"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center justify-center gap-3">
              <input
                type="number"
                inputMode="decimal"
                step="0.25"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                autoFocus
                className="w-20 text-center text-2xl bg-steel rounded-xl py-3 font-extrabold text-concrete"
              />
              <button
                onClick={confirm}
                className="bg-safety text-steel font-extrabold px-5 py-3 rounded-xl"
              >
                {tr.done}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ForemanPicker({
  roster,
  rosterLoaded,
  tr,
  lang,
  setLang,
  onPick,
  current,
  onCancel,
}: {
  roster: string[];
  rosterLoaded: boolean;
  tr: ReturnType<typeof t>;
  lang: Lang;
  setLang: (l: Lang) => void;
  onPick: (n: string) => void;
  current: string;
  onCancel?: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return roster;
    return roster.filter((n) => n.toLowerCase().includes(query));
  }, [q, roster]);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar tr={tr} lang={lang} setLang={setLang} />
      <div className="px-5 flex-1 flex flex-col">
        <h1 className="text-2xl font-extrabold mt-6 mb-1">{tr.pickForeman}</h1>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr.searchForeman}
          className="w-full bg-graphite rounded-xl px-4 py-3 my-4 text-concrete placeholder:text-rebar/60"
        />
        <div className="flex-1 overflow-y-auto space-y-2 pb-6">
          {!rosterLoaded && (
            <div className="text-rebar">{tr.loading}</div>
          )}
          {list.map((n) => (
            <button
              key={n}
              onClick={() => onPick(n)}
              className={`w-full text-left px-4 py-4 rounded-2xl font-semibold ${
                n === current
                  ? "bg-safety text-steel"
                  : "bg-graphite text-concrete active:bg-line"
              }`}
            >
              {n}
            </button>
          ))}
          {rosterLoaded && list.length === 0 && (
            <div className="text-rebar text-sm">
              {q.trim()
                ? lang === "es"
                  ? "Sin resultados"
                  : "No matches"
                : ""}
            </div>
          )}
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            className="mb-6 py-4 rounded-2xl bg-graphite text-concrete font-semibold"
          >
            {tr.back}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- helpers ----------
// Put the foreman in the crew (at the top) if he's not already there.
function ensureForeman(name: string, list: Worker[]): Worker[] {
  if (!name) return list;
  if (list.some((w) => w.name.toLowerCase() === name.toLowerCase())) return list;
  return [{ name, hours: null }, ...list];
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function prettyDate(iso: string, lang: Lang) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const monthsEs = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  const monthsEn = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const daysEs = [
    "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado",
  ];
  const daysEn = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const day = (lang === "es" ? daysEs : daysEn)[dow];
  const mo = (lang === "es" ? monthsEs : monthsEn)[m - 1];
  return `${day}, ${d} ${mo} ${y}`;
}

// ============================================================================
// Reconciliation cockpit — admin tool with two views (Find + Review).
// Find: pull up any worker, see their timecard entries + flags, edit/void/note.
// Review: schedule-vs-actual discrepancies (built next stage).
// ============================================================================

type ReconEntry = {
  id: string;
  worker: string;
  date: string;
  job: string;
  projectName: string;
  projectId: string;
  hours: number;
  foreman: string;
  notes: string;
  voided: boolean;
  voidNote: string;
};

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
function mondayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const back = (dow + 6) % 7; // days since Monday
  return isoAddDays(iso, -back);
}

const FLAG_LABEL: Record<string, string> = {
  duplicate: "Duplicate",
  multi_job: "Two jobs same day",
  over_hours: "Over 11 hrs that day",
  single_high: "High hours",
};

function ReconPanel({
  tr,
  lang,
  onClose,
}: {
  tr: ReturnType<typeof t>;
  lang: Lang;
  onClose: () => void;
}) {
  const today = (() => {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  })();

  const [view, setView] = useState<"find" | "review">("find");

  // date range
  const [rangeMode, setRangeMode] = useState<"this" | "last" | "custom">("this");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);

  const { start, end } = useMemo(() => {
    if (rangeMode === "this") {
      const mon = mondayOf(today);
      return { start: mon, end: isoAddDays(mon, 6) };
    }
    if (rangeMode === "last") {
      const mon = isoAddDays(mondayOf(today), -7);
      return { start: mon, end: isoAddDays(mon, 6) };
    }
    return { start: customStart, end: customEnd };
  }, [rangeMode, customStart, customEnd, today]);

  // worker search
  const [workers, setWorkers] = useState<string[]>([]);
  const [worker, setWorker] = useState<string>("");
  const [workerQuery, setWorkerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [entries, setEntries] = useState<ReconEntry[]>([]);
  const [flags, setFlags] = useState<Record<string, string[]>>({});
  const [confirmed, setConfirmed] = useState<{ key: string; refs: string; pageId: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [showVoided, setShowVoided] = useState(false);

  // load roster once
  useEffect(() => {
    fetch("/api/recon?action=roster")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.workers)) setWorkers(d.workers);
      })
      .catch(() => {});
  }, []);

  const search = useCallback(() => {
    if (!worker) return;
    setLoading(true);
    setMsg("");
    const url = `/api/recon?start=${start}&end=${end}&worker=${encodeURIComponent(worker)}`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) {
          setEntries(d.entries || []);
          setFlags(d.flags || {});
          setConfirmed(d.confirmed || []);
          if ((d.entries || []).length === 0) setMsg("No timecards for this worker in that range.");
        } else {
          setMsg(d?.error || "Search failed.");
        }
        setLoading(false);
      })
      .catch(() => {
        setMsg("Search failed.");
        setLoading(false);
      });
  }, [worker, start, end]);

  // auto-search when worker or range changes
  useEffect(() => {
    if (worker) search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker, start, end]);

  const filteredWorkers = workers.filter((w) =>
    w.toLowerCase().includes(workerQuery.toLowerCase())
  );

  // ---- edit / void / note modals ----
  const [editEntry, setEditEntry] = useState<ReconEntry | null>(null);
  const [voidEntry, setVoidEntry] = useState<ReconEntry | null>(null);

  function refreshAfterWrite() {
    search();
  }

  const flagLabel = (f: string) => FLAG_LABEL[f] || f;

  // The exact set of entry IDs that share a given flag on a given date
  // (worker is fixed by the search). Used for strict "reviewed" matching.
  function flagSetIds(date: string, flagCode: string): string {
    return entries
      .filter((e) => !e.voided && e.date === date && (flags[e.id] || []).includes(flagCode))
      .map((e) => e.id)
      .sort()
      .join(",");
  }

  // A flag is "reviewed OK" only if a log record matches worker+date+kind AND
  // the exact same entry set (Refs). Older records with empty Refs match on
  // worker+date+kind alone (lean fallback), so nothing breaks.
  function findReview(e: ReconEntry, f: string) {
    const key = `${e.worker.toLowerCase()}|${e.date}|${flagLabel(f).toLowerCase()}`;
    const setIds = flagSetIds(e.date, f);
    return confirmed.find((c) => c.key === key && (c.refs === "" || c.refs === setIds));
  }
  const isFlagOk = (e: ReconEntry, f: string) => !!findReview(e, f);

  return (
    <div className="fixed inset-0 z-[60] bg-steel overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 pb-28">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="w-9" />
          <div className="font-bold text-concrete text-lg">{tr.reconTitle}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full bg-graphite border border-line text-rebar flex items-center justify-center text-lg active:text-safety"
          >
            ✕
          </button>
        </div>

        {/* Toggle */}
        <div className="flex gap-1.5 bg-graphite border border-line rounded-full p-1 mb-5">
          <button
            onClick={() => setView("review")}
            className={`flex-1 rounded-full py-2.5 text-sm font-bold ${
              view === "review" ? "bg-safety text-steel" : "text-rebar"
            }`}
          >
            Review
          </button>
          <button
            onClick={() => setView("find")}
            className={`flex-1 rounded-full py-2.5 text-sm font-bold ${
              view === "find" ? "bg-safety text-steel" : "text-rebar"
            }`}
          >
            Find
          </button>
        </div>

        {/* Range selector — shared by both views */}
        <div className="flex gap-1.5 bg-graphite border border-line rounded-full p-1 mb-3">
          {([["this", "This week"], ["last", "Last week"], ["custom", "Custom"]] as const).map(
            ([k, label]) => (
              <button
                key={k}
                onClick={() => setRangeMode(k)}
                className={`flex-1 rounded-full py-2 text-xs font-bold ${
                  rangeMode === k ? "bg-steel text-concrete border border-line" : "text-rebar"
                }`}
              >
                {label}
              </button>
            )
          )}
        </div>
        {rangeMode === "custom" && (
          <div className="flex items-center gap-2 mb-3">
            <input
              type="date"
              value={customStart}
              max={today}
              onChange={(e) => setCustomStart(e.target.value)}
              className="flex-1 bg-graphite border border-line rounded-xl h-11 px-3 text-concrete text-sm"
            />
            <span className="text-rebar text-sm">to</span>
            <input
              type="date"
              value={customEnd}
              max={today}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="flex-1 bg-graphite border border-line rounded-xl h-11 px-3 text-concrete text-sm"
            />
          </div>
        )}

        {view === "find" ? (
          <>

            {/* Worker picker */}
            <button
              onClick={() => {
                setPickerOpen(true);
                setWorkerQuery("");
              }}
              className="w-full bg-graphite border border-line rounded-xl h-12 px-4 text-left mb-4 flex items-center justify-between"
            >
              <span className={worker ? "text-concrete font-semibold" : "text-rebar"}>
                {worker || "Search a worker…"}
              </span>
              <span className="text-rebar">▾</span>
            </button>

            {/* Results */}
            {loading && <div className="text-rebar text-sm px-1">Loading…</div>}
            {!loading && msg && <div className="text-rebar text-sm px-1 py-2">{msg}</div>}
            {!loading && worker && entries.length > 0 && (
              <div className="text-rebar text-xs mb-2 px-1">
                {entries.length} {entries.length === 1 ? "entry" : "entries"} · {prettyDate(start, lang).split(",")[1]?.trim() || start} – {prettyDate(end, lang).split(",")[1]?.trim() || end}
              </div>
            )}

            {!loading &&
              entries.filter((e) => !e.voided).map((e) => {
                const efl = flags[e.id] || [];
                const displayName = e.projectName || e.job || "—";
                const allOk = efl.length > 0 && efl.every((f) => isFlagOk(e, f));
                const edge = efl.length
                  ? allOk
                    ? "4px solid #4a9e63"
                    : "4px solid #e0a63b"
                  : undefined;
                const needsProject = !e.projectId;
                return (
                  <div
                    key={e.id}
                    className="bg-graphite border border-line rounded-2xl p-4 mb-3"
                    style={edge ? { borderLeft: edge } : undefined}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-safety text-xs font-bold uppercase tracking-wide mb-1">
                          {prettyDate(e.date, lang)}
                        </div>
                        <div className="text-concrete font-bold text-[15px]">{displayName}</div>
                        <div className="text-rebar text-xs mt-0.5">
                          Foreman: {e.foreman || "—"}
                          {e.projectName && e.job && e.job !== e.projectName && (
                            <span className="text-rebar/70"> · logged as "{e.job}"</span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="text-concrete text-xl font-extrabold">{e.hours}h</div>
                        {needsProject && (
                          <button
                            onClick={() => setEditEntry(e)}
                            className="text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap"
                            style={{ color: "#8fbcff", background: "rgba(47,115,216,.16)" }}
                          >
                            Set project ▸
                          </button>
                        )}
                      </div>
                    </div>

                    {efl.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2 items-center">
                        {efl.map((f) => {
                          const ok = isFlagOk(e, f);
                          return (
                            <span
                              key={f}
                              className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                              style={
                                ok
                                  ? { color: "#9fdcb4", background: "rgba(74,158,99,.16)" }
                                  : { color: "#f0cf8f", background: "rgba(224,166,59,.16)" }
                              }
                            >
                              {ok ? "✓" : "⚑"} {flagLabel(f)}
                            </span>
                          );
                        })}
                        {!allOk ? (
                          <button
                            onClick={async () => {
                              const toConfirm = efl.filter((f) => !isFlagOk(e, f));
                              const optimistic: { key: string; refs: string; pageId: string }[] = [];
                              for (const f of toConfirm) {
                                const refs = flagSetIds(e.date, f);
                                await fetch("/api/recon", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    op: "log",
                                    worker: e.worker,
                                    date: e.date,
                                    kind: flagLabel(f),
                                    status: "Confirmed OK",
                                    note: displayName,
                                    refs,
                                  }),
                                });
                                optimistic.push({
                                  key: `${e.worker.toLowerCase()}|${e.date}|${flagLabel(f).toLowerCase()}`,
                                  refs,
                                  pageId: "pending",
                                });
                              }
                              setConfirmed((c) => [...c, ...optimistic]);
                            }}
                            className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border border-line text-rebar active:text-safety"
                          >
                            Looks OK
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              // undo: archive each matching log record
                              const toUndo = efl
                                .map((f) => findReview(e, f))
                                .filter((r): r is { key: string; refs: string; pageId: string } => !!r);
                              for (const r of toUndo) {
                                if (r.pageId && r.pageId !== "pending") {
                                  await fetch("/api/recon", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ op: "unlog", pageId: r.pageId }),
                                  });
                                }
                              }
                              refreshAfterWrite();
                            }}
                            className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border border-line text-rebar active:text-safety"
                          >
                            Undo OK
                          </button>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2 mt-3 flex-wrap">
                      <button
                        onClick={() => setEditEntry(e)}
                        className="bg-graphite border border-line text-concrete rounded-lg px-4 py-2 text-sm font-bold active:text-safety"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setVoidEntry(e)}
                        className="text-rebar border border-line rounded-lg px-4 py-2 text-sm font-bold active:text-safety"
                      >
                        Void
                      </button>
                    </div>
                  </div>
                );
              })}

            {/* Collapsible voided section */}
            {!loading && entries.some((e) => e.voided) && (
              <div className="mt-4">
                <button
                  onClick={() => setShowVoided((v) => !v)}
                  className="w-full flex items-center justify-between text-rebar text-sm font-bold py-2 px-1"
                >
                  <span>Voided ({entries.filter((e) => e.voided).length})</span>
                  <span>{showVoided ? "▾" : "▸"}</span>
                </button>
                {showVoided &&
                  entries.filter((e) => e.voided).map((e) => (
                    <div key={e.id} className="bg-graphite border border-line rounded-2xl p-4 mb-3 opacity-60">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-rebar text-xs font-bold uppercase tracking-wide mb-1">
                            {prettyDate(e.date, lang)}
                          </div>
                          <div className="text-concrete font-bold text-[15px]">
                            {e.projectName || e.job || "—"}{" "}
                            <span className="text-rebar text-xs font-normal">(voided)</span>
                          </div>
                          <div className="text-rebar text-xs mt-0.5">Foreman: {e.foreman || "—"}</div>
                          {e.voidNote && (
                            <div className="text-rebar text-xs italic mt-1">Void note: {e.voidNote}</div>
                          )}
                        </div>
                        <div className="text-rebar text-xl font-extrabold">{e.hours}h</div>
                      </div>
                      <button
                        onClick={async () => {
                          await fetch("/api/recon", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ op: "void", id: e.id, voided: false, note: "" }),
                          });
                          refreshAfterWrite();
                        }}
                        className="mt-3 text-rebar border border-line rounded-lg px-4 py-2 text-sm font-bold active:text-safety"
                      >
                        Un-void
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        ) : (
          <ReconReviewView tr={tr} lang={lang} start={start} end={end} />
        )}
      </div>

      {/* Worker picker modal */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-[65] bg-black/50 flex items-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[75vh] sm:rounded-2xl border border-line overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="p-4 pb-2 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <div className="text-concrete font-bold">Find worker</div>
                <button
                  onClick={() => setPickerOpen(false)}
                  className="text-rebar text-xl leading-none px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <input
                autoFocus
                value={workerQuery}
                onChange={(ev) => setWorkerQuery(ev.target.value)}
                placeholder="Type a name…"
                className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
              />
            </div>
            <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
              {filteredWorkers.map((w) => (
                <button
                  key={w}
                  onClick={() => {
                    setWorker(w);
                    setPickerOpen(false);
                  }}
                  className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete"
                >
                  {w}
                </button>
              ))}
              {filteredWorkers.length === 0 && (
                <div className="text-rebar text-sm px-3 py-3">No matches.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editEntry && (
        <ReconEditModal
          entry={editEntry}
          lang={lang}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            setEditEntry(null);
            refreshAfterWrite();
          }}
        />
      )}

      {/* Void modal */}
      {voidEntry && (
        <ReconVoidModal
          entry={voidEntry}
          lang={lang}
          onClose={() => setVoidEntry(null)}
          onSaved={() => {
            setVoidEntry(null);
            refreshAfterWrite();
          }}
        />
      )}
    </div>
  );
}

function ReconEditModal({
  entry,
  lang,
  onClose,
  onSaved,
}: {
  entry: ReconEntry;
  lang: Lang;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hours, setHours] = useState(String(entry.hours));
  const [job, setJob] = useState(entry.job);
  const [foreman, setForeman] = useState(entry.foreman);
  const [projectId, setProjectId] = useState(entry.projectId);
  const [projectName, setProjectName] = useState(entry.projectName);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // project picker
  const [projects, setProjects] = useState<{ id: string; name: string; jobId: string }[]>([]);
  const [projPickerOpen, setProjPickerOpen] = useState(false);
  const [projQuery, setProjQuery] = useState("");
  // foreman picker (roster, excluding rodbusters)
  const [foremen, setForemen] = useState<string[]>([]);
  const [fmPickerOpen, setFmPickerOpen] = useState(false);
  const [fmQuery, setFmQuery] = useState("");
  useEffect(() => {
    fetch("/api/recon?action=foremen")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.foremen)) setForemen(d.foremen);
      })
      .catch(() => {});
  }, []);
  const filteredForemen = foremen.filter((f) => f.toLowerCase().includes(fmQuery.toLowerCase()));
  useEffect(() => {
    fetch("/api/recon?action=projects")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.projects)) setProjects(d.projects);
      })
      .catch(() => {});
  }, []);
  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(projQuery.toLowerCase()) ||
      (p.jobId || "").toLowerCase().includes(projQuery.toLowerCase())
  );

  const changed =
    parseFloat(hours) !== entry.hours ||
    job !== entry.job ||
    foreman !== entry.foreman ||
    projectId !== entry.projectId;

  async function save() {
    setSaving(true);
    const body: any = { op: "edit", id: entry.id };
    const changes: string[] = [];
    const h = parseFloat(hours);
    if (!isNaN(h) && h !== entry.hours) {
      body.hours = h;
      changes.push(`Hours ${entry.hours} → ${h}`);
    }
    if (job !== entry.job) {
      body.job = job;
      changes.push(`Job "${entry.job || "—"}" → "${job || "—"}"`);
    }
    if (foreman !== entry.foreman) {
      body.foreman = foreman;
      changes.push(`Foreman ${entry.foreman || "—"} → ${foreman || "—"}`);
    }
    if (projectId !== entry.projectId) {
      body.projectId = projectId;
      changes.push(`Project → ${projectName || "(cleared)"}`);
    }
    // change-logging fields (always logs the auto description; note optional)
    body.logWorker = entry.worker;
    body.logDate = entry.date;
    body.changeDesc = changes.join("; ");
    if (note.trim()) body.note = note.trim();
    await fetch("/api/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-5">
      <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-concrete font-bold text-lg">Edit timecard</div>
          <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
            ✕
          </button>
        </div>
        <div className="text-rebar text-xs mb-4">
          {entry.worker} · {prettyDate(entry.date, lang)}
        </div>

        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">Real project</label>
        <button
          onClick={() => {
            setProjPickerOpen(true);
            setProjQuery("");
          }}
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-left mb-1 flex items-center justify-between"
        >
          <span className={projectName ? "text-concrete" : "text-rebar"}>
            {projectName || "Pick the real project…"}
          </span>
          <span className="text-rebar">▾</span>
        </button>
        {projectName && (
          <button
            onClick={() => {
              setProjectId("");
              setProjectName("");
            }}
            className="text-rebar text-xs underline mb-3"
          >
            clear project
          </button>
        )}
        <div className="mb-3" />

        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">Hours</label>
        <input
          type="number"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-3"
        />
        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">
          Foreman's job name
        </label>
        <input
          value={job}
          onChange={(e) => setJob(e.target.value)}
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-3"
        />
        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">Foreman</label>
        <button
          onClick={() => {
            setFmPickerOpen(true);
            setFmQuery("");
          }}
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-left mb-4 flex items-center justify-between"
        >
          <span className={foreman ? "text-concrete" : "text-rebar"}>
            {foreman || "Pick a foreman…"}
          </span>
          <span className="text-rebar">▾</span>
        </button>

        {!confirm ? (
          <button
            disabled={!changed}
            onClick={() => setConfirm(true)}
            className="w-full bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-40"
          >
            Save changes
          </button>
        ) : (
          <div>
            <div className="text-concrete text-sm text-center mb-3">Save these changes?</div>
            <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">
              Reason (optional)
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. foreman miscounted"
              className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-1"
            />
            <div className="text-rebar text-[11px] mb-3">
              The change is logged either way; this adds context.
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirm(false)}
                className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
              >
                Cancel
              </button>
              <button
                disabled={saving}
                onClick={save}
                className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-60"
              >
                {saving ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Project picker (searchable) */}
      {projPickerOpen && (
        <div
          className="fixed inset-0 z-[75] bg-black/50 flex items-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => setProjPickerOpen(false)}
        >
          <div
            className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[75vh] sm:rounded-2xl border border-line overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="p-4 pb-2 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <div className="text-concrete font-bold">Pick project</div>
                <button
                  onClick={() => setProjPickerOpen(false)}
                  className="text-rebar text-xl leading-none px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <input
                autoFocus
                value={projQuery}
                onChange={(ev) => setProjQuery(ev.target.value)}
                placeholder="Search by name or job ID…"
                className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
              />
            </div>
            <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
              {filteredProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProjectId(p.id);
                    setProjectName(p.name);
                    setProjPickerOpen(false);
                  }}
                  className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete flex items-center justify-between"
                >
                  <span>{p.name}</span>
                  {p.jobId && <span className="text-rebar text-sm">{p.jobId}</span>}
                </button>
              ))}
              {filteredProjects.length === 0 && (
                <div className="text-rebar text-sm px-3 py-3">No matches.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Foreman picker (roster, excluding rodbusters) */}
      {fmPickerOpen && (
        <div
          className="fixed inset-0 z-[75] bg-black/50 flex items-stretch sm:items-center sm:justify-center sm:p-4"
          onClick={() => setFmPickerOpen(false)}
        >
          <div
            className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[75vh] sm:rounded-2xl border border-line overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="p-4 pb-2 border-b border-line">
              <div className="flex items-center justify-between mb-2">
                <div className="text-concrete font-bold">Pick foreman</div>
                <button
                  onClick={() => setFmPickerOpen(false)}
                  className="text-rebar text-xl leading-none px-2 active:text-safety"
                >
                  ✕
                </button>
              </div>
              <input
                autoFocus
                value={fmQuery}
                onChange={(ev) => setFmQuery(ev.target.value)}
                placeholder="Search a foreman…"
                className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
              />
            </div>
            <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
              {filteredForemen.map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    setForeman(f);
                    setFmPickerOpen(false);
                  }}
                  className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete"
                >
                  {f}
                </button>
              ))}
              {filteredForemen.length === 0 && (
                <div className="text-rebar text-sm px-3 py-3">No matches.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconVoidModal({
  entry,
  lang,
  onClose,
  onSaved,
}: {
  entry: ReconEntry;
  lang: Lang;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function doVoid() {
    setSaving(true);
    await fetch("/api/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "void", id: entry.id, voided: true, note }),
    });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-5">
      <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-concrete font-bold text-lg">Void this entry</div>
          <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
            ✕
          </button>
        </div>
        <div className="text-rebar text-xs mb-4">
          {entry.worker} · {entry.job} · {entry.hours}h · {prettyDate(entry.date, lang)}
        </div>
        <div className="text-rebar text-sm mb-3">
          The entry stays on record but is ignored by reports. You can un-void it anytime.
        </div>
        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">
          Why? (optional)
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. duplicate of the 8h entry"
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={doVoid}
            className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-60"
          >
            {saving ? "Voiding…" : "Void entry"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One schedule-vs-actual discrepancy card.
function DiscCard({
  d,
  lang,
  color,
  sev,
  busy,
  onAdd,
  onNoShow,
  onDismiss,
  onLooksRight,
  onViewCrew,
}: {
  d: any;
  lang: Lang;
  color: string;
  sev: string;
  busy: boolean;
  onAdd: () => void;
  onNoShow: () => void;
  onDismiss: () => void;
  onLooksRight: () => void;
  onViewCrew?: () => void;
}) {
  const isNoTimecard = d.kind === "No timecard";
  const kindLabel = isNoTimecard ? (sev === "pending" ? "No hours yet" : "No timecard") : d.kind;
  const spin = busy ? (
    <span className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin align-middle" />
  ) : null;
  return (
    <div
      className="bg-graphite border border-line rounded-2xl p-4 mb-3 relative"
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-concrete font-bold text-[15px]">{d.worker}</div>
          <div
            className="inline-block text-[11px] font-bold px-2 py-0.5 rounded-full mt-1"
            style={{ color, background: `${color}22` }}
          >
            {kindLabel}
          </div>
        </div>
        {isNoTimecard && onViewCrew ? (
          <button
            onClick={onViewCrew}
            className="text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap"
            style={{ color: "#8fbcff", background: "rgba(47,115,216,.16)" }}
          >
            View crew
          </button>
        ) : (
          d.hours > 0 && <div className="text-concrete text-lg font-extrabold">{d.hours}h</div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-line space-y-1.5 text-sm">
        {d.scheduledJob && (
          <div className="flex gap-3">
            <span className="text-rebar text-xs font-bold uppercase w-20 pt-0.5">Scheduled</span>
            <span className="text-concrete flex-1">
              {d.scheduledJob}
              {d.scheduledForeman && <span className="text-rebar"> · {d.scheduledForeman}</span>}
            </span>
          </div>
        )}
        <div className="flex gap-3">
          <span className="text-rebar text-xs font-bold uppercase w-20 pt-0.5">Logged</span>
          <span className={d.loggedJob ? "text-concrete flex-1" : "text-rebar italic flex-1"}>
            {d.loggedJob
              ? `${d.loggedJob}${d.loggedForeman ? ` · ${d.loggedForeman}` : ""}`
              : "nothing logged"}
          </span>
        </div>
      </div>

      {isNoTimecard && d.crewTotal > 1 && (
        <div className="text-rebar text-xs mt-2 italic">
          {d.crewLogged} of {d.crewTotal} scheduled crew logged this job
        </div>
      )}

      <div className="flex gap-2 mt-3 flex-wrap items-center">
        {isNoTimecard ? (
          <>
            <button
              onClick={onAdd}
              disabled={busy}
              className="bg-safety text-steel rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-60"
            >
              Add timecard
            </button>
            <button
              onClick={onNoShow}
              disabled={busy}
              className="text-rebar border border-line rounded-lg px-4 py-2 text-sm font-bold active:text-safety disabled:opacity-60"
            >
              No-show
            </button>
            <button
              onClick={onDismiss}
              disabled={busy}
              className="text-rebar border border-line rounded-lg px-4 py-2 text-sm font-bold active:text-safety disabled:opacity-60"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onLooksRight}
              disabled={busy}
              className="border border-line rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-60"
              style={{ color: "#9fdcb4" }}
            >
              Looks right
            </button>
            <button
              onClick={onDismiss}
              disabled={busy}
              className="text-rebar border border-line rounded-lg px-4 py-2 text-sm font-bold active:text-safety disabled:opacity-60"
            >
              Dismiss
            </button>
          </>
        )}
        {spin}
      </div>
    </div>
  );
}

// ============================================================================
// Review view — Stage A: "Needs real project" bulk-fix (grouped by the foreman's
// typed job name). Stage B (schedule-vs-actual checks + no-show) comes next.
// ============================================================================
function ReconReviewView({
  tr,
  lang,
  start,
  end,
}: {
  tr: ReturnType<typeof t>;
  lang: Lang;
  start: string;
  end: string;
}) {
  type Miss = {
    id: string;
    worker: string;
    date: string;
    job: string;
    projectName: string;
    projectId: string;
    hours: number;
    foreman: string;
    notes: string;
    voided: boolean;
    voidNote: string;
  };
  const [missing, setMissing] = useState<Miss[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [bulkGroup, setBulkGroup] = useState<string | null>(null); // "job|date" key
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editEntry, setEditEntry] = useState<Miss | null>(null);

  // schedule-vs-actual discrepancies
  type Disc = {
    kind: string;
    severity: "attention" | "pending" | "glance";
    worker: string;
    date: string;
    scheduledJob: string;
    scheduledJobId: string;
    scheduledForeman: string;
    loggedJob: string;
    loggedForeman: string;
    hours: number;
    crewLogged: number;
    crewTotal: number;
  };
  const [discs, setDiscs] = useState<Disc[]>([]);
  const [missingCards, setMissingCards] = useState<
    { foreman: string; jobName: string; date: string; jobId: string; crewCount: number }[]
  >([]);
  const [crews, setCrews] = useState<Record<string, { worker: string; logged: boolean }[]>>({});
  const [discLoading, setDiscLoading] = useState(false);
  const [ranCheck, setRanCheck] = useState(false);
  const [noShowFor, setNoShowFor] = useState<Disc | null>(null);
  const [addFor, setAddFor] = useState<Disc | null>(null);
  const [crewOpen, setCrewOpen] = useState<Record<string, boolean>>({});
  const [viewCrew, setViewCrew] = useState<{ jobId: string; date: string; job: string; foreman: string } | null>(null);
  const [dismissAllFor, setDismissAllFor] = useState<Disc[] | null>(null);
  const [busyKey, setBusyKey] = useState<string>(""); // which action button is working
  const [showMissing, setShowMissing] = useState(false);

  const today = (() => {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  })();

  const CACHE_KEY = "ammex_recon_cache";
  const CACHE_MS = 5 * 60 * 1000;
  const cacheTs = useRef(0);

  const load = useCallback(() => {
    setLoading(true);
    setMsg("");
    fetch(`/api/recon?action=needs_project&start=${start}&end=${end}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) setMissing(d.entries || []);
        else setMsg(d?.error || "Failed to load.");
        setLoading(false);
      })
      .catch(() => {
        setMsg("Failed to load.");
        setLoading(false);
      });
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const applyResult = useCallback((d: any) => {
    setDiscs(d.discrepancies || []);
    setMissingCards(d.missingCards || []);
    setCrews(d.crews || {});
  }, []);

  const loadDiscs = useCallback(() => {
    setDiscLoading(true);
    setRanCheck(true);
    fetch(`/api/recon?action=reconcile&start=${start}&end=${end}&today=${today}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) {
          applyResult(d);
          cacheTs.current = Date.now();
          try {
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({ start, end, ts: cacheTs.current, data: d })
            );
          } catch {}
        }
        setDiscLoading(false);
      })
      .catch(() => setDiscLoading(false));
  }, [start, end, today, applyResult]);

  // On mount / range change: use a fresh cache (same range, < 5 min) if present,
  // so the check survives tab switches and quick app re-opens.
  useEffect(() => {
    setRanCheck(false);
    setDiscs([]);
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.start === start && c.end === end && Date.now() - c.ts < CACHE_MS && c.data?.ok) {
          applyResult(c.data);
          cacheTs.current = c.ts;
          setRanCheck(true);
        }
      }
    } catch {}
  }, [start, end, applyResult]);

  // Keep the cache in sync after resolves so items don't reappear on tab switch.
  useEffect(() => {
    if (!ranCheck) return;
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          start,
          end,
          ts: cacheTs.current || Date.now(),
          data: { ok: true, discrepancies: discs, missingCards, crews },
        })
      );
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discs, missingCards, crews]);

  // resolve a discrepancy: log outcome + drop it from the list
  async function resolveDisc(d: Disc, status: string, note: string, key: string) {
    setBusyKey(key);
    await fetch("/api/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "log", worker: d.worker, date: d.date, kind: d.kind, status, note }),
    });
    setDiscs((cur) =>
      cur.filter((x) => !(x.worker === d.worker && x.date === d.date && x.kind === d.kind))
    );
    setBusyKey("");
  }

  // resolve many at once (bulk dismiss — job cancelled)
  async function resolveMany(items: Disc[], status: string, note: string) {
    for (const d of items) {
      await fetch("/api/recon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "log", worker: d.worker, date: d.date, kind: d.kind, status, note }),
      });
    }
    const keys = new Set(items.map((d) => `${d.worker}|${d.date}|${d.kind}`));
    setDiscs((cur) => cur.filter((x) => !keys.has(`${x.worker}|${x.date}|${x.kind}`)));
  }

  // One card per JOB NAME + DATE. Sorted by date, then job name.
  const groups = useMemo(() => {
    const m = new Map<string, Miss[]>();
    for (const e of missing) {
      const jobName = (e.job || "(no job name)").trim();
      const key = `${jobName}|${e.date}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(e);
    }
    return Array.from(m.entries())
      .map(([key, items]) => {
        const [job, date] = key.split("|");
        // foreman who submitted the card (from the timecards themselves)
        const foreman = items.find((i) => i.foreman)?.foreman || "—";
        const fLower = foreman.toLowerCase();
        return {
          key,
          job,
          date,
          foreman,
          // foreman's own row first (if present), then the rest alphabetical
          items: items.slice().sort((a, b) => {
            const af = a.worker.toLowerCase() === fLower ? 0 : 1;
            const bf = b.worker.toLowerCase() === fLower ? 0 : 1;
            return af - bf || a.worker.localeCompare(b.worker);
          }),
          workers: new Set(items.map((i) => i.worker)).size,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.job.localeCompare(b.job));
  }, [missing]);

  // group the cards by date, for the outside date section headers
  const byDate = useMemo(() => {
    const m = new Map<string, typeof groups>();
    for (const g of groups) {
      if (!m.has(g.date)) m.set(g.date, [] as any);
      m.get(g.date)!.push(g);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [groups]);

  return (
    <div>
      {missing.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-safety font-bold text-sm">Needs real project</span>
            <span className="text-rebar text-xs">
              {missing.length} {missing.length === 1 ? "entry" : "entries"} · {groups.length}{" "}
              {groups.length === 1 ? "card" : "cards"}
            </span>
          </div>
          <div className="text-rebar text-xs mb-4">
            These timecards have no real project set. Each card is one job on one day — assign the
            real project and it updates every entry in that card. Tap a card to see the entries.
          </div>
        </>
      )}

      {loading && <div className="text-rebar text-sm px-1">Loading…</div>}
      {!loading && msg && <div className="text-rebar text-sm px-1">{msg}</div>}
      {!loading && missing.length === 0 && !msg && (
        <div className="flex items-center gap-2 text-sm mb-2 px-1">
          <span className="text-green-400 font-bold" style={{ color: "#4a9e63" }}>✓</span>
          <span className="text-rebar">All projects set in this range.</span>
        </div>
      )}

      {!loading &&
        byDate.map(([date, cards]) => (
          <div key={date} className="mb-5">
            {/* Date section header — outside the cards */}
            <div className="text-safety text-xs font-bold uppercase tracking-wider mb-2 px-1">
              {prettyDate(date, lang)}
            </div>

            {cards.map((g) => {
              const open = !!expanded[g.key];
              return (
                <div key={g.key} className="bg-graphite border border-line rounded-2xl p-4 mb-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => setExpanded((s) => ({ ...s, [g.key]: !s[g.key] }))}
                      className="text-left flex-1"
                    >
                      <div className="text-concrete font-bold text-[15px]">
                        "{g.job}" <span className="text-rebar">{open ? "▾" : "▸"}</span>
                      </div>
                      <div className="text-rebar text-xs mt-0.5">{g.foreman}</div>
                      <div className="text-rebar text-xs mt-0.5">
                        {g.items.length} {g.items.length === 1 ? "entry" : "entries"} · {g.workers}{" "}
                        {g.workers === 1 ? "worker" : "workers"}
                      </div>
                    </button>
                    <button
                      onClick={() => setBulkGroup(g.key)}
                      className="bg-safety text-steel rounded-lg px-4 py-2 text-sm font-bold whitespace-nowrap"
                    >
                      Set project
                    </button>
                  </div>

                  {open && (
                    <div className="mt-3 pt-3 border-t border-line">
                      <div className="space-y-2">
                        {g.items.map((e) => {
                          const isForeman =
                            g.foreman !== "—" &&
                            e.worker.toLowerCase() === g.foreman.toLowerCase();
                          return (
                            <div
                              key={e.id}
                              className="flex items-center justify-between gap-3 rounded-xl px-3 py-2"
                              style={
                                isForeman
                                  ? {
                                      border: "1px solid rgba(47,115,216,.5)",
                                      background: "rgba(47,115,216,.08)",
                                    }
                                  : { background: "rgba(28,33,39,.4)" }
                              }
                            >
                              <div className="text-concrete text-sm font-semibold truncate min-w-0">
                                {e.worker}
                                {isForeman && (
                                  <span
                                    className="ml-2 text-[10px] font-bold uppercase tracking-wide"
                                    style={{ color: "#8fbcff" }}
                                  >
                                    Foreman
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <div className="text-concrete font-bold">{e.hours}h</div>
                                <button
                                  onClick={() => setEditEntry(e)}
                                  className="text-rebar border border-line rounded-lg px-3 py-1.5 text-xs font-bold active:text-safety"
                                >
                                  Edit
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

      {/* ---- Schedule vs. actual reconciliation ---- */}
      <div className="mt-8 mb-3 pt-5 border-t border-line">
        <div className="flex items-center justify-between gap-2">
          <div className="text-concrete font-bold text-base">Schedule vs. actual</div>
          {ranCheck && !discLoading && (
            <button
              onClick={loadDiscs}
              aria-label="Re-run check"
              className="w-9 h-9 rounded-full bg-graphite border border-line text-rebar flex items-center justify-center active:text-safety shrink-0"
            >
              ↻
            </button>
          )}
        </div>
        <div className="text-rebar text-xs mt-1">
          Compares who was scheduled against who logged hours.
        </div>
      </div>

      {!ranCheck && !discLoading && (
        <button
          onClick={loadDiscs}
          className="w-full bg-safety text-steel rounded-xl py-3.5 font-bold mb-3"
        >
          Run check
        </button>
      )}

      {discLoading && <div className="text-rebar text-sm px-1 py-3">Checking…</div>}

      {ranCheck && !discLoading && missingCards.length > 0 && (
        <button
          onClick={() => setShowMissing(true)}
          className="w-full flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-left"
          style={{ background: "rgba(229,83,60,.12)", border: "1px solid rgba(229,83,60,.4)" }}
        >
          <span style={{ color: "#e5533c" }} className="font-bold">⚠</span>
          <span className="text-concrete font-bold text-sm">
            {missingCards.length} missing {missingCards.length === 1 ? "card" : "cards"}
          </span>
          <span className="text-rebar text-xs ml-auto">tap to view →</span>
        </button>
      )}

      {ranCheck && !discLoading && discs.length === 0 && missingCards.length === 0 && (
        <div className="bg-graphite border border-line rounded-2xl p-6 text-center">
          <div className="text-concrete font-bold mb-1">All matched ✓</div>
          <div className="text-rebar text-sm">
            Everything scheduled lines up with what was logged in this range.
          </div>
        </div>
      )}

      {ranCheck && !discLoading && discs.length > 0 && (
        <>
          {(
            [
              ["attention", "Needs attention", "#e5533c", "Likely missed hours — look into these."],
              ["pending", "Pending", "#9aa3af", "Probably just not submitted yet."],
              ["glance", "Worth a glance", "#e0a63b", "Showed up, but not as planned."],
            ] as const
          ).map(([sev, label, color, explain]) => {
            const items = discs.filter((d) => d.severity === sev);
            if (items.length === 0) return null;

            return (
              <div key={sev} className="mb-6">
                <div className="mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color }}>
                      {label}
                    </span>
                    <span className="text-rebar text-xs">{items.length}</span>
                  </div>
                  <div className="text-rebar text-[11px] mt-0.5">{explain}</div>
                </div>

                {sev === "pending"
                  ? // PENDING: group by scheduled job + date (crew)
                    (() => {
                      const crews = new Map<string, typeof items>();
                      for (const d of items) {
                        const k = `${d.scheduledJobId}|${d.date}`;
                        if (!crews.has(k)) crews.set(k, [] as any);
                        crews.get(k)!.push(d);
                      }
                      const crewArr = Array.from(crews.entries()).sort((a, b) =>
                        a[1][0].date.localeCompare(b[1][0].date)
                      );
                      return crewArr.map(([k, crew]) => {
                        const first = crew[0];
                        const open = !!crewOpen[k];
                        const total = first.crewTotal || crew.length;
                        const logged = first.crewLogged || 0;
                        return (
                          <div
                            key={k}
                            className="bg-graphite border border-line rounded-2xl p-4 mb-3"
                            style={{ borderLeft: `4px solid ${color}` }}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <button
                                onClick={() => setCrewOpen((s) => ({ ...s, [k]: !s[k] }))}
                                className="text-left flex-1"
                              >
                                <div className="text-safety text-xs font-bold uppercase tracking-wide mb-1">
                                  {prettyDate(first.date, lang)}
                                </div>
                                <div className="text-concrete font-bold text-[15px]">
                                  {first.scheduledJob || "(job)"}{" "}
                                  <span className="text-rebar">{open ? "▾" : "▸"}</span>
                                </div>
                                <div className="text-rebar text-xs mt-0.5">
                                  {first.scheduledForeman || "—"}
                                </div>
                                <div className="text-rebar text-xs mt-0.5">
                                  {logged} of {total} scheduled logged · {crew.length} still out
                                </div>
                              </button>
                            </div>

                            {open && (
                              <div className="mt-3 pt-3 border-t border-line space-y-2">
                                {crew.map((d) => {
                                  const bk = `${d.worker}|${d.date}|${d.kind}`;
                                  const busy = busyKey === bk;
                                  return (
                                    <div
                                      key={`${d.worker}|${d.date}`}
                                      className="bg-steel/40 rounded-xl px-3 py-2"
                                    >
                                      <div className="text-concrete text-sm font-semibold mb-1.5 flex items-center gap-2">
                                        {d.worker}
                                        {busy && (
                                          <span className="inline-block w-3 h-3 border-2 border-rebar border-t-transparent rounded-full animate-spin" />
                                        )}
                                      </div>
                                      <div className="flex gap-2 flex-wrap">
                                        <button
                                          onClick={() => setAddFor(d)}
                                          disabled={busy}
                                          className="bg-safety text-steel rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                                        >
                                          Add timecard
                                        </button>
                                        <button
                                          onClick={() => setNoShowFor(d)}
                                          disabled={busy}
                                          className="text-rebar border border-line rounded-lg px-3 py-1.5 text-xs font-bold active:text-safety disabled:opacity-60"
                                        >
                                          No-show
                                        </button>
                                        <button
                                          onClick={() => resolveDisc(d, "Dismissed", "", bk)}
                                          disabled={busy}
                                          className="text-rebar border border-line rounded-lg px-3 py-1.5 text-xs font-bold active:text-safety disabled:opacity-60"
                                        >
                                          Dismiss
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                                <button
                                  onClick={() => setDismissAllFor(crew)}
                                  className="w-full text-rebar border border-line rounded-lg py-2 text-xs font-bold mt-1 active:text-safety"
                                >
                                  Dismiss all (job cancelled)
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()
                  : // ATTENTION & GLANCE: group by date (oldest-first for
                    // attention, newest-first for glance), cluster by crew+kind.
                    (() => {
                      const byDate = new Map<string, typeof items>();
                      for (const d of items) {
                        if (!byDate.has(d.date)) byDate.set(d.date, [] as any);
                        byDate.get(d.date)!.push(d);
                      }
                      const dateArr = Array.from(byDate.entries()).sort((a, b) =>
                        sev === "attention"
                          ? a[0].localeCompare(b[0]) // oldest first
                          : b[0].localeCompare(a[0]) // newest first
                      );
                      return dateArr.map(([date, dItems]) => {
                        // cluster: same crew (job+foreman) together, then by kind
                        const sorted = dItems
                          .slice()
                          .sort(
                            (a, b) =>
                              (a.scheduledJobId || "").localeCompare(b.scheduledJobId || "") ||
                              a.kind.localeCompare(b.kind) ||
                              a.worker.localeCompare(b.worker)
                          );
                        return (
                          <div key={date} className="mb-4">
                            <div
                              className="text-safety text-xs font-bold uppercase tracking-wider mb-2 px-1 py-1 sticky top-0 z-10"
                              style={{ background: "#1c2127" }}
                            >
                              {prettyDate(date, lang)}
                            </div>
                            {sorted.map((d, i) => {
                              const bk = `${d.worker}|${d.date}|${d.kind}`;
                              return (
                                <DiscCard
                                  key={`${bk}|${i}`}
                                  d={d}
                                  lang={lang}
                                  color={color}
                                  sev={sev}
                                  busy={busyKey === bk}
                                  onAdd={() => setAddFor(d)}
                                  onNoShow={() => setNoShowFor(d)}
                                  onDismiss={() => resolveDisc(d, "Dismissed", "", bk)}
                                  onLooksRight={() => resolveDisc(d, "Confirmed OK", "", bk)}
                                  onViewCrew={
                                    d.kind === "No timecard" && d.scheduledJobId
                                      ? () =>
                                          setViewCrew({
                                            jobId: d.scheduledJobId,
                                            date: d.date,
                                            job: d.scheduledJob,
                                            foreman: d.scheduledForeman,
                                          })
                                      : undefined
                                  }
                                />
                              );
                            })}
                          </div>
                        );
                      });
                    })()}
              </div>
            );
          })}
        </>
      )}

      {bulkGroup && (
        <ReconBulkProjectModal
          jobName={groups.find((g) => g.key === bulkGroup)?.job || ""}
          dateLabel={prettyDate(groups.find((g) => g.key === bulkGroup)?.date || "", lang)}
          entries={groups.find((g) => g.key === bulkGroup)?.items || []}
          onClose={() => setBulkGroup(null)}
          onDone={() => {
            setBulkGroup(null);
            load();
          }}
        />
      )}

      {editEntry && (
        <ReconEditModal
          entry={editEntry as any}
          lang={lang}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            setEditEntry(null);
            load();
          }}
        />
      )}

      {noShowFor && (
        <ReconNoShowModal
          disc={noShowFor}
          lang={lang}
          onClose={() => setNoShowFor(null)}
          onDone={(note) => {
            resolveDisc(noShowFor, "No-show", note, `${noShowFor.worker}|${noShowFor.date}|${noShowFor.kind}`);
            setNoShowFor(null);
          }}
        />
      )}

      {addFor && (
        <ReconAddModal
          disc={addFor}
          lang={lang}
          onClose={() => setAddFor(null)}
          onDone={() => {
            setAddFor(null);
            loadDiscs();
          }}
        />
      )}

      {viewCrew && (
        <ReconCrewModal
          info={viewCrew}
          crew={crews[`${viewCrew.jobId}|${viewCrew.date}`] || []}
          lang={lang}
          onClose={() => setViewCrew(null)}
        />
      )}

      {dismissAllFor && (
        <ReconDismissAllModal
          count={dismissAllFor.length}
          onClose={() => setDismissAllFor(null)}
          onConfirm={() => {
            resolveMany(dismissAllFor, "Dismissed", "job cancelled — crew stood down");
            setDismissAllFor(null);
          }}
        />
      )}

      {showMissing && (
        <ReconMissingCardsModal
          cards={missingCards}
          lang={lang}
          onClose={() => setShowMissing(false)}
        />
      )}
    </div>
  );
}

function ReconBulkProjectModal({
  jobName,
  dateLabel,
  entries,
  onClose,
  onDone,
}: {
  jobName: string;
  dateLabel: string;
  entries: { id: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [projects, setProjects] = useState<{ id: string; name: string; jobId: string }[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    fetch("/api/recon?action=projects")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.projects)) setProjects(d.projects);
      })
      .catch(() => {});
  }, []);

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      (p.jobId || "").toLowerCase().includes(query.toLowerCase())
  );

  async function apply() {
    if (!picked) return;
    setSaving(true);
    setProgress(`Updating ${entries.length}…`);
    const res = await fetch("/api/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "bulk_project",
        ids: entries.map((e) => e.id),
        projectId: picked.id,
      }),
    }).then((r) => r.json()).catch(() => null);
    setSaving(false);
    if (res?.ok) onDone();
    else setProgress("Something went wrong. Try again.");
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-stretch sm:items-center sm:justify-center sm:p-4">
      <div className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[80vh] sm:rounded-2xl border border-line overflow-hidden">
        <div className="p-4 pb-2 border-b border-line">
          <div className="flex items-center justify-between mb-1">
            <div className="text-concrete font-bold">Set project</div>
            <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
              ✕
            </button>
          </div>
          <div className="text-rebar text-xs mb-2">
            "{jobName}" · {dateLabel} · {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </div>
          {!picked ? (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or job ID…"
              className="w-full bg-steel rounded-xl px-3 h-11 text-concrete"
            />
          ) : null}
        </div>

        {!picked ? (
          <div className="space-y-1 p-3 overflow-y-auto overscroll-contain">
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => setPicked({ id: p.id, name: p.name })}
                className="w-full text-left px-3 py-3 rounded-xl active:bg-steel text-concrete flex items-center justify-between"
              >
                <span>{p.name}</span>
                {p.jobId && <span className="text-rebar text-sm">{p.jobId}</span>}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="text-rebar text-sm px-3 py-3">No matches.</div>
            )}
          </div>
        ) : (
          <div className="p-5">
            <div className="text-concrete text-center mb-1">Set</div>
            <div className="text-safety font-bold text-center text-lg mb-1">{picked.name}</div>
            <div className="text-rebar text-sm text-center mb-5">
              on all {entries.length} "{jobName}" {entries.length === 1 ? "entry" : "entries"}?
            </div>
            {progress && <div className="text-rebar text-sm text-center mb-3">{progress}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setPicked(null)}
                disabled={saving}
                className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
              >
                Back
              </button>
              <button
                onClick={apply}
                disabled={saving}
                className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-60"
              >
                {saving ? "Updating…" : "Confirm"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// No-show: record that a scheduled worker didn't report (resolves the flag).
function ReconNoShowModal({
  disc,
  lang,
  onClose,
  onDone,
}: {
  disc: { worker: string; date: string; scheduledJob: string; scheduledForeman: string };
  lang: Lang;
  onClose: () => void;
  onDone: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-5">
      <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-concrete font-bold text-lg">Mark no-show</div>
          <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
            ✕
          </button>
        </div>
        <div className="text-rebar text-xs mb-4">
          {disc.worker} · {prettyDate(disc.date, lang)} · {disc.scheduledJob}
        </div>
        <div className="text-rebar text-sm mb-3">
          Records that this scheduled worker didn't report. It resolves the flag and stays on record.
        </div>
        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">
          Note (optional)
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. called out sick"
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
          >
            Cancel
          </button>
          <button
            onClick={() => onDone(note.trim())}
            className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold"
          >
            Mark no-show
          </button>
        </div>
      </div>
    </div>
  );
}

// Add a missing timecard (deliberate — not auto-filled), pre-seeded from the schedule.
function ReconAddModal({
  disc,
  lang,
  onClose,
  onDone,
}: {
  disc: {
    worker: string;
    date: string;
    scheduledJob: string;
    scheduledForeman: string;
  };
  lang: Lang;
  onClose: () => void;
  onDone: () => void;
}) {
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    const h = parseFloat(hours);
    if (isNaN(h)) return;
    setSaving(true);
    await fetch("/api/recon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "add",
        worker: disc.worker,
        date: disc.date,
        job: disc.scheduledJob,
        hours: h,
        foreman: disc.scheduledForeman,
      }),
    });
    setSaving(false);
    onDone();
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-5">
      <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-concrete font-bold text-lg">Add timecard</div>
          <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
            ✕
          </button>
        </div>
        <div className="text-rebar text-xs mb-4">
          {disc.worker} · {prettyDate(disc.date, lang)}
        </div>
        <div className="bg-steel/40 rounded-xl p-3 mb-4 text-sm">
          <div className="text-rebar text-xs">Job (from schedule)</div>
          <div className="text-concrete font-semibold">{disc.scheduledJob || "—"}</div>
          <div className="text-rebar text-xs mt-2">Foreman</div>
          <div className="text-concrete font-semibold">{disc.scheduledForeman || "—"}</div>
        </div>
        <label className="block text-rebar text-xs font-bold uppercase tracking-wide mb-1">Hours</label>
        <input
          type="number"
          autoFocus
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="e.g. 8"
          className="w-full bg-steel border border-line rounded-xl h-11 px-3 text-concrete mb-4"
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
          >
            Cancel
          </button>
          <button
            onClick={add}
            disabled={saving || !hours}
            className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add timecard"}
          </button>
        </div>
      </div>
    </div>
  );
}

// View the scheduled crew for a job+date. Missing (didn't log) = soft red; the
// rest (logged, locked in) are dimmed/disabled.
function ReconCrewModal({
  info,
  crew,
  lang,
  onClose,
}: {
  info: { jobId: string; date: string; job: string; foreman: string };
  crew: { worker: string; logged: boolean }[];
  lang: Lang;
  onClose: () => void;
}) {
  const missing = crew.filter((c) => !c.logged);
  const logged = crew.filter((c) => c.logged);
  return (
    <div className="fixed inset-0 z-[75] bg-black/60 flex items-stretch sm:items-center sm:justify-center sm:p-4">
      <div className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[80vh] sm:rounded-2xl border border-line overflow-hidden">
        <div className="p-4 border-b border-line">
          <div className="flex items-center justify-between mb-1">
            <div className="text-concrete font-bold">Scheduled crew</div>
            <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
              ✕
            </button>
          </div>
          <div className="text-rebar text-xs">
            {info.job || "(job)"} · {prettyDate(info.date, lang)}
            {info.foreman ? ` · ${info.foreman}` : ""}
          </div>
        </div>
        <div className="p-3 overflow-y-auto overscroll-contain space-y-2">
          {missing.length > 0 && (
            <div className="text-[11px] font-bold uppercase tracking-wide px-1" style={{ color: "#e5533c" }}>
              Missing ({missing.length})
            </div>
          )}
          {missing.map((c) => (
            <div
              key={c.worker}
              className="rounded-xl px-3 py-2.5 text-sm font-semibold text-concrete"
              style={{ border: "1px solid rgba(229,83,60,.5)", background: "rgba(229,83,60,.08)" }}
            >
              {c.worker}
            </div>
          ))}
          {logged.length > 0 && (
            <div className="text-[11px] font-bold uppercase tracking-wide px-1 pt-2 text-rebar">
              Logged ({logged.length})
            </div>
          )}
          {logged.map((c) => (
            <div
              key={c.worker}
              className="rounded-xl px-3 py-2.5 text-sm font-semibold bg-steel/40 text-rebar opacity-60 flex items-center justify-between"
            >
              {c.worker}
              <span className="text-[10px]" style={{ color: "#4a9e63" }}>✓ logged</span>
            </div>
          ))}
          {crew.length === 0 && (
            <div className="text-rebar text-sm px-2 py-3">No scheduled crew found.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Bulk-dismiss safety: requires ticking a checkbox before Confirm enables.
function ReconDismissAllModal({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-5">
      <div className="bg-graphite border border-line rounded-2xl w-full max-w-sm p-5">
        <div className="text-concrete font-bold text-lg mb-2">Dismiss whole crew?</div>
        <div className="text-rebar text-sm mb-4">
          This dismisses all {count} scheduled {count === 1 ? "worker" : "workers"} for this job —
          use it only when the job was cancelled and the crew was sent home. It can't be batch-undone.
        </div>
        <label className="flex items-start gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 w-5 h-5 shrink-0"
          />
          <span className="text-concrete text-sm">
            I understand this dismisses all {count} and the job was cancelled.
          </span>
        </label>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-steel border border-line text-concrete rounded-xl py-3 font-bold"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!checked}
            className="flex-1 bg-safety text-steel rounded-xl py-3 font-bold disabled:opacity-40"
          >
            Dismiss all
          </button>
        </div>
      </div>
    </div>
  );
}

// Quick-reference: foremen who haven't submitted a card (whole crew blank).
function ReconMissingCardsModal({
  cards,
  lang,
  onClose,
}: {
  cards: { foreman: string; jobName: string; date: string; jobId: string; crewCount: number }[];
  lang: Lang;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[75] bg-black/60 flex items-stretch sm:items-center sm:justify-center sm:p-4">
      <div className="bg-graphite w-full sm:max-w-md flex flex-col h-full sm:h-auto sm:max-h-[80vh] sm:rounded-2xl border border-line overflow-hidden">
        <div className="p-4 border-b border-line">
          <div className="flex items-center justify-between mb-1">
            <div className="text-concrete font-bold">Missing cards</div>
            <button onClick={onClose} className="text-rebar text-xl px-2 active:text-safety">
              ✕
            </button>
          </div>
          <div className="text-rebar text-xs">Foremen who haven't submitted a card yet — chase these.</div>
        </div>
        <div className="p-3 overflow-y-auto overscroll-contain space-y-2">
          {cards.map((c, i) => {
            const short = prettyDate(c.date, lang).split(",")[0];
            return (
              <div
                key={`${c.jobId}|${c.date}|${i}`}
                className="rounded-xl px-3 py-3"
                style={{ border: "1px solid rgba(229,83,60,.4)", background: "rgba(229,83,60,.06)" }}
              >
                <div className="text-concrete font-bold text-sm">{c.foreman || "(no foreman)"}</div>
                <div className="text-rebar text-xs mt-0.5">
                  {c.jobName} · {short} · {c.crewCount} crew
                </div>
              </div>
            );
          })}
          {cards.length === 0 && (
            <div className="text-rebar text-sm px-2 py-3">No missing cards.</div>
          )}
        </div>
      </div>
    </div>
  );
}
