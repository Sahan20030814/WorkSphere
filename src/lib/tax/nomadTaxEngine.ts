/**
 * nomadTaxEngine.ts
 * Multi-jurisdiction physical presence, 183-day tax residency compliance engine,
 * and rolling-window visa stay calculations (Schengen 90/180, UK 180).
 * Resolves transitional travel day collisions according to IATA/OECD tax residency conventions.
 */

export interface TaxPresenceEntry {
  id: string;
  userId: string;
  countryCode: string; // ISO 2-letter country code (e.g. "US", "ES", "PT", "MX")
  jurisdiction: string; // Human-readable country/region name
  timestamp: string; // ISO string e.g. "2026-03-15T14:30:00Z"
  timezone?: string;
  entryType?: "CHECK_IN" | "BOOKING" | "BORDER_CROSSING" | "MANUAL";
  isArrival?: boolean;
  isDeparture?: boolean;
}

export interface JurisdictionPresenceSummary {
  countryCode: string;
  jurisdiction: string;
  daysCount: number;
  isTaxResidentRisk: boolean; // >= 183 days
  daysRemainingBefore183: number;
  riskLevel: "LOW" | "WARNING" | "CRITICAL";
  firstSeen: string;
  lastSeen: string;
}

export interface TaxCollisionResolution {
  date: string; // YYYY-MM-DD
  conflictingCountries: string[];
  allocatedCountry: string;
  resolutionReason: string;
}

export interface NomadTaxComplianceReport {
  userId: string;
  taxYear: number;
  totalUniqueCalendarDays: number;
  collisionsResolvedCount: number;
  jurisdictions: JurisdictionPresenceSummary[];
  collisions: TaxCollisionResolution[];
  warnings: string[];
}

export interface NomadTaxOptions {
  taxYear?: number;
  taxResidencyThresholdDays?: number; // Default 183 days
  collisionRule?: "DESTINATION_PRIORITY" | "LATEST_TIMESTAMP" | "FIRST_TIMESTAMP";
}

export interface NomadCheckInRecord {
  id: string;
  venueId: string;
  venueName: string;
  city: string;
  country: string;
  countryCode: string; // ISO 2-letter e.g. "ES", "PT", "DE", "JP", "GB", "US"
  isSchengen: boolean;
  date: string; // "YYYY-MM-DD"
  amountSpent: number;
  currency: string;
  vatRatePct: number;
}

export interface VisaZoneLimit {
  zoneName: string;
  maxDays: number;
  windowDays: number;
  daysUsed: number;
  daysRemaining: number;
  status: "SAFE" | "WARNING" | "CRITICAL_LIMIT";
  taxResidencyRisk: boolean;
}

export interface NomadComplianceReport {
  taxYear: number;
  schengenStay: VisaZoneLimit;
  countryBreakdown: Array<{
    country: string;
    countryCode: string;
    daysSpent: number;
    daysRemaining183Rule: number;
    taxResidencyRisk: boolean;
    totalSpent: number;
    vatReclaimable: number;
    currency: string;
  }>;
  totalWorkspaceExpense: number;
  totalVatReclaimable: number;
  currency: string;
  generatedAt: string;
}

const SCHENGEN_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IS", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "CH"
]);

/**
 * Normalizes an ISO timestamp string to YYYY-MM-DD calendar date string in UTC.
 */
export function toCalendarDateString(timestamp: string): string {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp string: ${timestamp}`);
  }
  return date.toISOString().split("T")[0];
}

const MS_PER_DAY = 86_400_000;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Returns the "YYYY-MM-DD" calendar day written in a date string, or null when
 * it is not a real calendar date. The day is read as written (no time-zone
 * conversion), so a stay dated "2026-01-01" is always on 1 January.
 */
function toDayKey(value: string): string | null {
  const key = typeof value === "string" ? value.slice(0, 10) : "";
  if (!DAY_KEY_PATTERN.test(key)) return null;
  const parsed = new Date(`${key}T00:00:00Z`);
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key
    ? key
    : null;
}

/** Adds whole calendar days to a "YYYY-MM-DD" key (UTC has no DST, so this is exact). */
function addDaysToDayKey(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Resolves the reference instant to the calendar day it falls on in `timeZone`
 * (default UTC). A plain "YYYY-MM-DD" string is used as the day directly.
 */
function toReferenceDayKey(referenceDate: Date | string, timeZone = "UTC"): string {
  if (typeof referenceDate === "string" && DAY_KEY_PATTERN.test(referenceDate)) {
    const key = toDayKey(referenceDate);
    if (key) return key;
  }
  const instant = new Date(referenceDate);
  if (isNaN(instant.getTime())) {
    throw new Error(`Invalid reference date: ${String(referenceDate)}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Calculates physical presence days across jurisdictions while resolving
 * multi-country collisions on transitional travel days without double-counting.
 */
export function calculateNomadTaxPresence(
  entries: TaxPresenceEntry[],
  options: NomadTaxOptions = {}
): NomadTaxComplianceReport {
  const threshold = options.taxResidencyThresholdDays ?? 183;
  const collisionRule = options.collisionRule ?? "DESTINATION_PRIORITY";
  const userId = entries.length > 0 ? entries[0].userId : "anonymous";
  const taxYear = options.taxYear ?? new Date().getUTCFullYear();

  // Filter entries matching the specified tax year if taxYear option provided
  const filteredEntries = entries.filter((e) => {
    const entryDate = new Date(e.timestamp);
    return !isNaN(entryDate.getTime()) && entryDate.getUTCFullYear() === taxYear;
  });

  // Group entries by calendar date YYYY-MM-DD
  const dateMap = new Map<string, TaxPresenceEntry[]>();

  for (const entry of filteredEntries) {
    const dateKey = toCalendarDateString(entry.timestamp);
    if (!dateMap.has(dateKey)) {
      dateMap.set(dateKey, []);
    }
    dateMap.get(dateKey)!.push(entry);
  }

  const jurisdictionDaysMap = new Map<
    string,
    {
      countryCode: string;
      jurisdiction: string;
      days: Set<string>;
      firstSeen: string;
      lastSeen: string;
    }
  >();

  const collisions: TaxCollisionResolution[] = [];

  // Sort dates chronologically
  const sortedDates = Array.from(dateMap.keys()).sort();

  for (const dateKey of sortedDates) {
    const dayEntries = dateMap.get(dateKey)!;

    // Get unique country codes present on this calendar day
    const uniqueCountriesOnDay = Array.from(
      new Set(dayEntries.map((e) => e.countryCode))
    );

    let allocatedEntry: TaxPresenceEntry;

    if (uniqueCountriesOnDay.length > 1) {
      // MULTI-JURISDICTION COLLISION DETECTED: Nomad traveled across countries on same date
      // Resolve according to IATA/OECD tax residency conventions:
      // Priority 1: Check for explicit `isArrival` entry
      const arrivalEntry = dayEntries.find((e) => e.isArrival);
      if (arrivalEntry) {
        allocatedEntry = arrivalEntry;
      } else if (collisionRule === "FIRST_TIMESTAMP") {
        // Priority by earliest timestamp
        allocatedEntry = [...dayEntries].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )[0];
      } else {
        // Priority by latest timestamp (default destination on travel day)
        allocatedEntry = [...dayEntries].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )[0];
      }

      collisions.push({
        date: dateKey,
        conflictingCountries: uniqueCountriesOnDay,
        allocatedCountry: allocatedEntry.countryCode,
        resolutionReason: arrivalEntry
          ? `Arrival priority allocated to ${allocatedEntry.jurisdiction} (${allocatedEntry.countryCode})`
          : `Transitional travel day collision resolved to destination ${allocatedEntry.jurisdiction} (${allocatedEntry.countryCode}) based on latest timestamp`,
      });
    } else {
      allocatedEntry = dayEntries[0];
    }

    // Allocate 1 unique physical day to the resolved country
    const code = allocatedEntry.countryCode;
    if (!jurisdictionDaysMap.has(code)) {
      jurisdictionDaysMap.set(code, {
        countryCode: code,
        jurisdiction: allocatedEntry.jurisdiction,
        days: new Set<string>(),
        firstSeen: allocatedEntry.timestamp,
        lastSeen: allocatedEntry.timestamp,
      });
    }

    const record = jurisdictionDaysMap.get(code)!;
    record.days.add(dateKey);

    if (new Date(allocatedEntry.timestamp) < new Date(record.firstSeen)) {
      record.firstSeen = allocatedEntry.timestamp;
    }
    if (new Date(allocatedEntry.timestamp) > new Date(record.lastSeen)) {
      record.lastSeen = allocatedEntry.timestamp;
    }
  }

  // Build jurisdiction summaries and compliance alerts
  const jurisdictions: JurisdictionPresenceSummary[] = Array.from(
    jurisdictionDaysMap.values()
  ).map((item) => {
    const daysCount = item.days.size;
    const isTaxResidentRisk = daysCount >= threshold;
    const daysRemainingBefore183 = Math.max(0, threshold - daysCount);

    let riskLevel: JurisdictionPresenceSummary["riskLevel"] = "LOW";
    if (daysCount >= threshold) {
      riskLevel = "CRITICAL";
    } else if (daysCount >= threshold - 30) {
      riskLevel = "WARNING";
    }

    return {
      countryCode: item.countryCode,
      jurisdiction: item.jurisdiction,
      daysCount,
      isTaxResidentRisk,
      daysRemainingBefore183,
      riskLevel,
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
    };
  });

  // Sort jurisdictions by days count descending
  jurisdictions.sort((a, b) => b.daysCount - a.daysCount);

  const warnings: string[] = [];
  for (const j of jurisdictions) {
    if (j.isTaxResidentRisk) {
      warnings.push(
        `CRITICAL TAX RESIDENCY RISK: Reached ${j.daysCount} physical days in ${j.jurisdiction} (${j.countryCode}), triggering potential 183-day tax residency.`
      );
    } else if (j.riskLevel === "WARNING") {
      warnings.push(
        `Tax Residency Warning: Approaching 183-day threshold in ${j.jurisdiction} (${j.daysCount} days logged, ${j.daysRemainingBefore183} days remaining).`
      );
    }
  }

  return {
    userId,
    taxYear,
    totalUniqueCalendarDays: dateMap.size,
    collisionsResolvedCount: collisions.length,
    jurisdictions,
    collisions,
    warnings,
  };
}

/**
 * Calculates rolling Schengen days used in the 180-day window that ends on (and
 * includes) the reference day.
 *
 * The window is made of whole calendar days, so the result never depends on the
 * time of day or the server's time zone. `referenceDate` may be a Date or a
 * "YYYY-MM-DD" string; pass `options.timeZone` (IANA name, default "UTC") to
 * evaluate "today" in the traveller's own time zone.
 */
export function calculateSchengenStay(
  records: NomadCheckInRecord[],
  referenceDate: Date | string = new Date(),
  options: { timeZone?: string } = {}
): VisaZoneLimit {
  const windowDays = 180;
  const maxDays = 90;

  const referenceDay = toReferenceDayKey(referenceDate, options.timeZone);
  const windowStartDay = addDaysToDayKey(referenceDay, -(windowDays - 1));

  const uniqueSchengenDates = new Set<string>();

  records.forEach((r) => {
    if (r.isSchengen || SCHENGEN_COUNTRIES.has(r.countryCode.toUpperCase())) {
      const recordDay = toDayKey(r.date);
      if (recordDay && recordDay >= windowStartDay && recordDay <= referenceDay) {
        uniqueSchengenDates.add(recordDay);
      }
    }
  });

  const daysUsed = uniqueSchengenDates.size;
  const daysRemaining = Math.max(0, maxDays - daysUsed);

  let status: VisaZoneLimit["status"] = "SAFE";
  if (daysRemaining <= 14) status = "CRITICAL_LIMIT";
  else if (daysRemaining <= 30) status = "WARNING";

  return {
    zoneName: "Schengen Area (90/180 Rule)",
    maxDays,
    windowDays,
    daysUsed,
    daysRemaining,
    status,
    taxResidencyRisk: daysUsed >= 85,
  };
}

/**
 * Computes full country breakdown and tax residency risks.
 */
export function generateNomadComplianceReport(
  records: NomadCheckInRecord[],
  taxYear = new Date().getUTCFullYear()
): NomadComplianceReport {
  const schengenStay = calculateSchengenStay(records);

  const countryMap = new Map<
    string,
    {
      country: string;
      countryCode: string;
      dates: Set<string>;
      totalSpent: number;
      vatReclaimable: number;
      currency: string;
    }
  >();

  let totalWorkspaceExpense = 0;
  let totalVatReclaimable = 0;

  records.forEach((r) => {
    // Read the year from the calendar date itself: getFullYear() would apply the
    // server's time zone to a UTC-parsed date and push 1 Jan into the prior year.
    const recordDay = toDayKey(r.date);
    if (recordDay !== null && Number(recordDay.slice(0, 4)) === taxYear) {
      if (!countryMap.has(r.countryCode)) {
        countryMap.set(r.countryCode, {
          country: r.country,
          countryCode: r.countryCode,
          dates: new Set(),
          totalSpent: 0,
          vatReclaimable: 0,
          currency: r.currency || "USD",
        });
      }

      const c = countryMap.get(r.countryCode)!;
      c.dates.add(recordDay);
      c.totalSpent += r.amountSpent;
      const vat = r.amountSpent * (r.vatRatePct / 100);
      c.vatReclaimable += vat;

      totalWorkspaceExpense += r.amountSpent;
      totalVatReclaimable += vat;
    }
  });

  const countryBreakdown = Array.from(countryMap.values()).map((c) => {
    const daysSpent = c.dates.size;
    const daysRemaining183Rule = Math.max(0, 183 - daysSpent);
    return {
      country: c.country,
      countryCode: c.countryCode,
      daysSpent,
      daysRemaining183Rule,
      taxResidencyRisk: daysSpent >= 150,
      totalSpent: Number(c.totalSpent.toFixed(2)),
      vatReclaimable: Number(c.vatReclaimable.toFixed(2)),
      currency: c.currency,
    };
  });

  countryBreakdown.sort((a, b) => b.daysSpent - a.daysSpent);

  return {
    taxYear,
    schengenStay,
    countryBreakdown,
    totalWorkspaceExpense: Number(totalWorkspaceExpense.toFixed(2)),
    totalVatReclaimable: Number(totalVatReclaimable.toFixed(2)),
    currency: "USD",
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Formats compliance report as tax-deductible CSV.
 */
export function exportComplianceReportCSV(report: NomadComplianceReport): string {
  const headers = [
    "Jurisdiction",
    "Country Code",
    "Days In-Country",
    "Days to 183-Tax Trigger",
    "Tax Risk Flag",
    "Total Workspace Expense (USD)",
    "Estimated VAT/GST Reclaim (USD)",
  ];

  const rows = report.countryBreakdown.map((c) => [
    `"${c.country}"`,
    c.countryCode,
    c.daysSpent,
    c.daysRemaining183Rule,
    c.taxResidencyRisk ? "HIGH_RISK" : "SAFE",
    c.totalSpent.toFixed(2),
    c.vatReclaimable.toFixed(2),
  ]);

  const summary = [
    "",
    `"Schengen 90/180 Status","${report.schengenStay.daysUsed} / 90 Days Used (${report.schengenStay.daysRemaining} Remaining)","Status: ${report.schengenStay.status}"`,
    `"Total Tax Deductible Workspace Expenses","USD ${report.totalWorkspaceExpense.toFixed(2)}"`,
    `"Total Reclaimable VAT/GST","USD ${report.totalVatReclaimable.toFixed(2)}"`,
  ];

  return [headers.join(","), ...rows.map((r) => r.join(",")), ...summary].join("\n");
}
