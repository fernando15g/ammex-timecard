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

export default function Page() {
  const [lang, setLang] = useState<Lang>("es");
  const tr = t(lang);

  const [foreman, setForeman] = useState<string>("");
  const [showForemanPicker, setShowForemanPicker] = useState(false);

  const [date, setDate] = useState<string>(todayISO());
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
        if (d.date) {
          setDate(d.date);
          // A saved draft may hold a deliberately chosen date; if it's not
          // today, treat it as manual so focus re-check won't overwrite it.
          if (d.date !== todayISO()) dateManual.current = true;
        }
        if (typeof d.job === "string") setJob(d.job);
        let restored: Worker[] = Array.isArray(d.workers) ? d.workers : [];
        if (savedForeman && !foremanRemoved.current) {
          restored = ensureForeman(savedForeman, restored);
        }
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
            <div className="mb-3 rounded-2xl bg-safety/15 border border-safety/40 px-4 py-3 flex items-start gap-2">
              <span className="text-safety text-base leading-none mt-0.5">⚠</span>
              <span className="text-sm text-concrete">
                {tr.dateNotToday.replace("{date}", prettyDate(date, lang))}
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
  return (
    <div className="min-h-screen flex flex-col">
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
        {/* Foreman line */}
        <button
          onClick={() => setShowForemanPicker(true)}
          className="w-full flex items-center justify-between mt-4 mb-5 text-left"
        >
          <div>
            <div className="text-[11px] font-bold text-rebar tracking-wide">
              {tr.foreman.toUpperCase()}
            </div>
            <div className="text-lg font-bold">{foreman}</div>
          </div>
          <span className="text-safety text-sm font-semibold">
            {tr.changeForeman}
          </span>
        </button>

        {/* Date + Job */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <Field label={tr.date}>
            <input
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => {
                dateManual.current = true;
                setDate(e.target.value);
              }}
              className="w-full min-w-0 box-border h-12 bg-graphite rounded-xl px-3 text-concrete appearance-none"
            />
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
      const file = new File([blob], filename, { type: "application/pdf" });
      const nav: any = navigator;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return;
      }
      // Fallback: open the PDF in a new tab (user can then save/share).
      const url = URL.createObjectURL(blob);
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
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const newJobRef = useRef<HTMLDivElement>(null);
  const jobSearchRef = useRef<HTMLInputElement>(null);
  const workerSearchRef = useRef<HTMLInputElement>(null);

  // Swipe-down-to-close for the picker sheets (phone). Drag the grab handle
  // down; release past a threshold to dismiss.
  function onDragStart(e: React.TouchEvent) {
    dragStartRef.current = e.touches[0].clientY;
    setDragY(0);
  }
  function onDragMove(e: React.TouchEvent) {
    if (dragStartRef.current == null) return;
    const d = e.touches[0].clientY - dragStartRef.current;
    if (d > 0) setDragY(d);
  }
  function onDragEnd(close: () => void) {
    if (dragY > 90) close();
    dragStartRef.current = null;
    setDragY(0);
  }

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
    <div className="fixed inset-0 z-[60] bg-steel overflow-y-auto">
      <div className="max-w-7xl mx-auto p-4 pb-28">
        {/* Header — Close on the right to match the rest of the app */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="text-rebar font-semibold text-sm flex items-center gap-1.5 active:text-safety disabled:opacity-50"
          >
            <svg
              width="15" height="15" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <div className="font-bold text-concrete text-lg">{tr.scheduleTitle}</div>
          <button onClick={onClose} className="text-rebar font-semibold">Close ✕</button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-graphite border border-line rounded-xl px-3 h-11 text-concrete"
          />
          <button
            onClick={carryOver}
            className="bg-graphite border border-line rounded-xl px-3 h-11 text-concrete font-semibold text-sm"
          >
            ↺ Carry over last
          </button>
          {jobs.length > 0 && (
            <button
              onClick={() => setJobs([])}
              className="ml-auto text-rebar border border-line rounded-xl px-3 h-11 text-sm"
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
            style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }}
          >
            {/* Grab handle — swipe down to close (phone) */}
            <div
              className="sm:hidden pt-2 pb-1 flex justify-center touch-none"
              onTouchStart={onDragStart}
              onTouchMove={onDragMove}
              onTouchEnd={() => onDragEnd(() => { setShowJobPicker(false); setJobQuery(""); })}
            >
              <div className="w-10 h-1.5 rounded-full bg-line" />
            </div>
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
            <div className="space-y-1 p-3 overflow-y-auto">
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
            style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }}
          >
            {/* Grab handle — swipe down to close (phone) */}
            <div
              className="sm:hidden pt-2 pb-1 flex justify-center touch-none"
              onTouchStart={onDragStart}
              onTouchMove={onDragMove}
              onTouchEnd={() => onDragEnd(() => { setWorkerFor(null); setWorkerQuery(""); })}
            >
              <div className="w-10 h-1.5 rounded-full bg-line" />
            </div>
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
            <div className="space-y-1 p-3 overflow-y-auto">
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
