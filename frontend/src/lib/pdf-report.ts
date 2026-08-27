import { jsPDF } from "jspdf";
import html2canvas from "html2canvas-pro";
import type { AnalyticsSummary } from "./types";
import { formatUsd } from "./utils";

// html2canvas-pro rather than html2canvas: the theme is authored in modern
// CSS colour functions (oklch/color-mix reach the page through Tailwind v4),
// which the original library cannot parse and fails on outright.

const MARGIN = 14;
const PAGE_W = 210; // A4 portrait, mm
const PAGE_H = 297;

interface ReportMeta {
  orgName: string;
  generatedBy: string;
}

function line(doc: jsPDF, y: number): void {
  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
}

/**
 * Builds a shareable salary report: the same figures the dashboard shows,
 * plus an image of each chart captured from the live DOM so the PDF can
 * never disagree with the screen it was exported from.
 */
export async function buildSalaryReport(
  summary: AnalyticsSummary,
  chartNodes: HTMLElement[],
  meta: ReportMeta,
): Promise<Blob> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text("Salary Report", MARGIN, y + 6);

  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(meta.orgName, MARGIN, y + 13);
  doc.text(
    `Generated ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })} by ${meta.generatedBy}`,
    MARGIN,
    y + 18,
  );
  y += 24;
  line(doc, y);
  y += 8;

  // --- Headline figures -------------------------------------------------
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text("Summary", MARGIN, y);
  y += 6;

  const stats: [string, string][] = [
    ["Headcount", summary.headcount.toLocaleString()],
    ["Average salary", formatUsd(summary.avgUsd)],
    ["Median salary", formatUsd(summary.medianUsd)],
    ["Total payroll cost", formatUsd(summary.totalCostUsd)],
  ];

  const cardW = (PAGE_W - MARGIN * 2 - 6) / 2;
  stats.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * (cardW + 6);
    const cardY = y + row * 20;
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, cardY, cardW, 16, 1, 1);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(label.toUpperCase(), x + 4, cardY + 6);
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text(value, x + 4, cardY + 12.5);
  });
  y += Math.ceil(stats.length / 2) * 20 + 6;

  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    "All amounts normalized to USD using the recorded FX snapshot. Active employees only.",
    MARGIN,
    y,
  );
  y += 8;

  // --- Charts, captured from the live dashboard -------------------------
  for (const node of chartNodes) {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff", logging: false });
    const imgW = PAGE_W - MARGIN * 2;
    const imgH = (canvas.height / canvas.width) * imgW;

    if (y + imgH > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
    doc.addImage(canvas.toDataURL("image/png"), "PNG", MARGIN, y, imgW, imgH);
    y += imgH + 6;
  }

  // --- Breakdown tables -------------------------------------------------
  const tables: [string, string, { key: string; headcount: number; avgUsd: number }[]][] = [
    ["By department", "Department", summary.byDepartment.map((d) => ({ key: d.department, ...d }))],
    ["By country", "Country", summary.byCountry.map((c) => ({ key: c.country, ...c }))],
    ["By level", "Level", summary.byLevel.map((l) => ({ key: l.level, ...l }))],
  ];

  for (const [title, columnLabel, rows] of tables) {
    if (rows.length === 0) continue;

    // 12mm of header plus one row is the least that's worth starting on a
    // page - anything less and the title strands alone at the bottom.
    if (y + 20 > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(title, MARGIN, y);
    y += 6;

    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(columnLabel, MARGIN, y);
    doc.text("Headcount", MARGIN + 90, y, { align: "right" });
    doc.text("Avg salary (USD)", PAGE_W - MARGIN, y, { align: "right" });
    y += 2;
    line(doc, y);
    y += 4;

    doc.setTextColor(15, 23, 42);
    for (const row of rows) {
      if (y > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(String(row.key), MARGIN, y);
      doc.text(row.headcount.toLocaleString(), MARGIN + 90, y, { align: "right" });
      doc.text(formatUsd(row.avgUsd), PAGE_W - MARGIN, y, { align: "right" });
      y += 5;
    }
    y += 6;
  }

  // Page numbers last, once the total is known.
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_W - MARGIN, PAGE_H - 8, { align: "right" });
    doc.text(meta.orgName, MARGIN, PAGE_H - 8);
  }

  return doc.output("blob");
}
