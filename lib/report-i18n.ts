// Localized strings for the generated report (labels + flag phrasing).
// The app UI strings live in lib/strings.ts; this is just for the PDF/Excel.

export type ReportLang = "en" | "es";

export const DAY_NAMES: Record<ReportLang, string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  es: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
};

export const RT: Record<ReportLang, Record<string, string>> = {
  en: {
    payrollTitle: "Weekly Payroll",
    rangeJoin: "to",
    worker: "Worker",
    total: "Total",
    dailyTotal: "Daily total",
    jobId: "Job ID",
    unassigned: "UNASSIGNED",
    noHoursHeader: "NO HOURS LOGGED THIS WEEK",
    everyoneLogged: "Everyone on the roster logged hours.",
    flagsHeader: "FLAGS TO REVIEW",
    none: "None.",
    foremanLabel: "Foreman",
    workerReportTitle: "Weekly Payroll — by Worker",
    weekTotal: "Week total",
    hrs: "hrs",
  },
  es: {
    payrollTitle: "Nómina Semanal",
    rangeJoin: "a",
    worker: "Trabajador",
    total: "Total",
    dailyTotal: "Total diario",
    jobId: "ID de obra",
    unassigned: "SIN ASIGNAR",
    noHoursHeader: "SIN HORAS REGISTRADAS ESTA SEMANA",
    everyoneLogged: "Todos en la lista registraron horas.",
    flagsHeader: "ALERTAS PARA REVISAR",
    none: "Ninguna.",
    foremanLabel: "Mayordomo",
    workerReportTitle: "Nómina Semanal — por Trabajador",
    weekTotal: "Total de la semana",
    hrs: "hrs",
  },
};

// ---- Flag phrase builders (full localized lines) ----

export function phraseOverHours(
  lang: ReportLang,
  total: number,
  parts: { hours: number; job: string; foreman: string }[],
  threshold: number
): string {
  if (lang === "es") {
    const ps = parts.map(
      (p) => `${p.hours} hrs en ${p.job}${p.foreman ? ` por ${p.foreman}` : ""}`
    );
    return `${total} hrs en total — ${ps.join(" + ")} (más de ${threshold}/día)`;
  }
  const ps = parts.map(
    (p) => `${p.hours} hrs on ${p.job}${p.foreman ? ` by ${p.foreman}` : ""}`
  );
  return `${total} hrs total — ${ps.join(" + ")} (over ${threshold}/day)`;
}

export function phraseDoubleEntry(
  lang: ReportLang,
  count: number,
  job: string,
  parts: { hours: number; foreman: string }[]
): string {
  if (lang === "es") {
    const ps = parts.map(
      (p) => `${p.hours} hrs${p.foreman ? ` (${p.foreman})` : ""}`
    );
    return `Posible registro doble — ${count} registros en ${job}: ${ps.join(" + ")}`;
  }
  const ps = parts.map(
    (p) => `${p.hours} hrs${p.foreman ? ` (${p.foreman})` : ""}`
  );
  return `Possible double entry — ${count} entries on ${job}: ${ps.join(" + ")}`;
}

export function phraseMultiJob(
  lang: ReportLang,
  count: number,
  parts: string[]
): string {
  if (lang === "es") {
    return `En ${count} obras el mismo día: ${parts.join(" + ")}`;
  }
  return `On ${count} jobs same day: ${parts.join(" + ")}`;
}

export function phraseSingleHigh(
  lang: ReportLang,
  hours: number,
  job: string,
  foreman: string,
  limit: number
): string {
  if (lang === "es") {
    return `Registro único de ${hours} hrs en ${job}${
      foreman ? ` por ${foreman}` : ""
    } (más de ${limit})`;
  }
  return `Single entry of ${hours} hrs on ${job}${
    foreman ? ` by ${foreman}` : ""
  } (over ${limit})`;
}

export function phraseOffRoster(lang: ReportLang): string {
  return lang === "es"
    ? "No está en la lista activa — revisa el nombre"
    : "Not on active roster — check name/spelling";
}
